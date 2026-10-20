import { IMAGE_TYPES_BY_EXTENSION, getFileExtension, normalizeMimeType } from '../utils/mimeTypes.js';

const MAX_IMAGE_DIMENSION = 4096;
const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;

const OUTPUT_FORMATS = new Map([
    ['image/jpeg', 'image/jpeg'],
    ['image/jpg', 'image/jpeg'],
    ['image/png', 'image/png'],
    ['image/webp', 'image/webp'],
    ['image/avif', 'image/avif'],
    ['image/gif', 'image/gif'],
]);

const OUTPUT_FORMAT_PRIORITY = [
    'image/avif',
    'image/webp',
    'image/jpeg',
    'image/png',
    'image/gif',
];

const OUTPUT_FORMAT_BY_NAME = new Map([
    ['avif', 'image/avif'],
    ['image/avif', 'image/avif'],
    ['webp', 'image/webp'],
    ['image/webp', 'image/webp'],
    ['jpeg', 'image/jpeg'],
    ['jpg', 'image/jpeg'],
    ['jpe', 'image/jpeg'],
    ['jfif', 'image/jpeg'],
    ['image/jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['image/png', 'image/png'],
    ['gif', 'image/gif'],
    ['image/gif', 'image/gif'],
]);

export function parseImageTransform(url, accessConfig = {}, acceptType = null) {
    const defaultFormatMode = normalizeDefaultFormatMode(accessConfig.imageTransformDefaultFormat);
    const widthResult = parseDimension(url.searchParams, 'width');
    const heightResult = parseDimension(url.searchParams, 'height');
    const fitResult = parseFit(url.searchParams);
    const fallbackResult = parseFallback(url.searchParams);
    const outputResult = parseOutput(url.searchParams, acceptType, defaultFormatMode);

    if (widthResult.error || heightResult.error || fitResult.error || fallbackResult.error || outputResult.error) {
        return {
            requested: true,
            error: widthResult.error || heightResult.error || fitResult.error || fallbackResult.error || outputResult.error,
        };
    }

    const requested = widthResult.present || heightResult.present || fitResult.present || fallbackResult.present || outputResult.present;
    if (!requested) {
        return { requested: false };
    }

    // 仅由 Accept 自动触发的格式转换：未启用时直接返回原文件，转换失败时回退到原文件
    const explicitlyRequested = widthResult.present || heightResult.present || fitResult.present || fallbackResult.present || !outputResult.implicit;
    if (!explicitlyRequested) {
        if (accessConfig.imageTransformEnabled !== true) {
            return { requested: false };
        }

        return {
            requested: true,
            implicit: true,
            sizeKey: 'autoxauto',
            fallback: 'original',
            outputFormat: outputResult.value,
            options: {},
        };
    }

    if (fallbackResult.present && !widthResult.present && !heightResult.present && !fitResult.present && !outputResult.present) {
        return {
            requested: true,
            error: 'fallback=original requires image resizing parameters',
        };
    }

    if (accessConfig.imageTransformEnabled !== true) {
        return {
            requested: true,
            error: 'Image resizing is disabled',
            errorStatus: 403,
        };
    }

    const width = widthResult.value;
    const height = heightResult.value;
    const fit = fitResult.value;

    if (fit && (!width || !height)) {
        return {
            requested: true,
            error: `fit=${fit} requires both width and height`,
        };
    }

    const sizeKey = `${width || 'auto'}x${height || 'auto'}`;
    const allowedSizes = parseAllowedSizes(accessConfig.imageTransformAllowedSizes);

    if (allowedSizes.size > 0 && !allowedSizes.has(sizeKey)) {
        return {
            requested: true,
            error: `Image size ${sizeKey} is not allowed`,
        };
    }

    return {
        requested: true,
        sizeKey,
        fallback: fallbackResult.value,
        outputFormat: outputResult.value,
        options: {
            ...(width ? { width } : {}),
            ...(height ? { height } : {}),
            ...(fit ? { fit } : {}),
        },
    };
}

export function validateImageTransformRequest(request, imageTransform) {
    if (!imageTransform.requested) return null;

    if (imageTransform.error) {
        return imageTransformError(imageTransform.error, imageTransform.errorStatus || 400);
    }

    if (request.method !== 'GET') {
        return imageTransformError('Image resizing only supports GET requests', 405, {
            Allow: 'GET',
        });
    }

    if (request.headers.has('Range')) {
        return imageTransformError('Range requests cannot be combined with image resizing', 400);
    }

    return null;
}

export function validateImageTransformSource(imageTransform, env, fileType, fileName) {
    if (!imageTransform?.requested) {
        return null;
    }

    const metadataType = normalizeMimeType(fileType);
    const inferredType = metadataType || inferImageTypeFromFileName(fileName);
    if (!inferredType || canTransformImageType(env, inferredType)) {
        return null;
    }

    if (imageTransform.fallback === 'original') {
        return { fallbackToOriginal: true };
    }

    return {
        response: imageTransformError(`Unsupported image type: ${inferredType}`, 415),
    };
}

export async function transformImageRequestViaUrl(context) {
    const { env, imageTransform, request } = context;
    if (!imageTransform?.requested || hasConfiguredImageProcessor(env)) {
        return null;
    }

    // Image Resizing fetches the source through this same file route. Never
    // start another transformation for that internal source request.
    if (/image-resizing/i.test(request.headers.get('Via') || '')) {
        return null;
    }

    const sourceUrl = new URL(request.url);
    sourceUrl.searchParams.delete('width');
    sourceUrl.searchParams.delete('height');
    sourceUrl.searchParams.delete('fit');
    sourceUrl.searchParams.delete('fallback');
    sourceUrl.searchParams.delete('output');

    const transformOptions = Object.entries({
        ...(imageTransform.outputFormat ? { format: mimeToTransformFormat(imageTransform.outputFormat) } : {}),
        ...imageTransform.options,
        ...(imageTransform.fallback === 'original' ? { onerror: 'redirect' } : {}),
    })
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join(',');
    const transformUrl = new URL(
        `/cdn-cgi/image/${transformOptions}${sourceUrl.pathname}${sourceUrl.search}`,
        sourceUrl.origin
    );

    return new Response(null, {
        status: 302,
        headers: {
            'Location': transformUrl.toString(),
            'Cache-Control': 'private, no-store, max-age=0',
        },
    });
}

export async function transformImageResponse(context, response) {
    const imageTransform = context.imageTransform;
    if (!imageTransform?.requested || response.status !== 200 || !response.body) {
        return response;
    }

    const sourceType = normalizeMimeType(response.headers.get('Content-Type'));
    const outputFormat = resolveOutputFormat(context.request, sourceType, imageTransform.outputFormat);
    if (!canTransformImageType(context.env, sourceType)) {
        if (imageTransform.fallback === 'original') {
            return response;
        }
        return imageTransformError(`Unsupported image type: ${sourceType || 'unknown'}`, 415);
    }

    const contentLength = parseContentLength(response.headers.get('Content-Length'));
    if (contentLength !== null && contentLength > MAX_IMAGE_INPUT_BYTES) {
        if (imageTransform.fallback === 'original') {
            return response;
        }
        return imageTransformError('Image resizing supports source files up to 20 MB', 413);
    }

    const fallbackResponse = imageTransform.fallback === 'original' ? response.clone() : null;

    try {
        const transformed = await runImageTransform(
            context.env,
            response.body,
            imageTransform.options,
            sourceType,
            outputFormat
        );
        if (fallbackResponse && !transformed.ok) {
            return fallbackResponse;
        }
        if (fallbackResponse?.body) {
            await fallbackResponse.body.cancel().catch(() => {});
        }
        const headers = mergeTransformedHeaders(response.headers, transformed.headers, outputFormat);

        return new Response(transformed.body, {
            status: transformed.status,
            statusText: transformed.statusText,
            headers,
        });
    } catch (error) {
        if (fallbackResponse) {
            return fallbackResponse;
        }

        const hasExplicitStatus = Number.isInteger(error.statusCode);
        if (!hasExplicitStatus) {
            console.error('Image transformation failed:', error);
        }
        const status = hasExplicitStatus ? error.statusCode : 422;
        return imageTransformError(`Image transformation failed: ${error.message || 'unknown error'}`, status);
    }
}

async function runImageTransform(env, stream, options, sourceType, outputFormat) {
    const images = env?.IMAGES;
    if (images && typeof images.input === 'function') {
        const output = await images
            .input(stream)
            .transform(options)
            .output({
                format: outputFormat,
                ...(sourceType === 'image/gif' ? { anim: true } : {}),
            });
        return output.response();
    }

    const processor = env?.IMAGE_PROCESSOR;
    if (processor && typeof processor.transform === 'function') {
        return await processor.transform(stream, {
            ...options,
            sourceType,
            outputFormat,
        });
    }

    const error = new Error('no image processor is configured');
    error.statusCode = 501;
    throw error;
}

function hasConfiguredImageProcessor(env) {
    const images = env?.IMAGES;
    if (images && typeof images.input === 'function') {
        return true;
    }

    return hasConfiguredStreamImageProcessor(env);
}

function hasConfiguredStreamImageProcessor(env) {
    const processor = env?.IMAGE_PROCESSOR;
    return Boolean(processor && typeof processor.transform === 'function');
}

function canTransformImageType(env, sourceType) {
    if (!OUTPUT_FORMATS.has(sourceType)) {
        return false;
    }

    if (sourceType === 'image/gif') {
        return hasConfiguredStreamImageProcessor(env);
    }

    if (sourceType === 'image/avif') {
        return hasConfiguredImageProcessor(env);
    }

    return true;
}

function parseDimension(searchParams, name) {
    const values = searchParams.getAll(name);
    if (values.length === 0) return { present: false, value: null };
    if (values.length !== 1) return { present: true, error: `Duplicate ${name} parameter` };

    const rawValue = values[0];
    if (!/^[1-9]\d*$/.test(rawValue)) {
        return { present: true, error: `${name} must be a positive integer` };
    }

    const value = Number(rawValue);
    if (!Number.isSafeInteger(value) || value > MAX_IMAGE_DIMENSION) {
        return { present: true, error: `${name} must be between 1 and ${MAX_IMAGE_DIMENSION}` };
    }

    return { present: true, value };
}

function parseFit(searchParams) {
    const values = searchParams.getAll('fit');
    if (values.length === 0) return { present: false, value: null };
    if (values.length !== 1) return { present: true, error: 'Duplicate fit parameter' };
    if (values[0] !== 'cover' && values[0] !== 'squeeze') {
        return { present: true, error: 'fit must be cover or squeeze' };
    }

    return { present: true, value: values[0] };
}

function parseFallback(searchParams) {
    const values = searchParams.getAll('fallback');
    if (values.length === 0) return { present: false, value: null };
    if (values.length !== 1) return { present: true, error: 'Duplicate fallback parameter' };
    if (values[0] !== 'original') {
        return { present: true, error: 'fallback must be original' };
    }

    return { present: true, value: values[0] };
}

function parseOutput(searchParams, acceptType = null, defaultFormatMode = 'auto') {
    const values = searchParams.getAll('output');
    if (values.length > 0) {
        if (values.length !== 1) {
            return { present: true, error: 'Duplicate output parameter' };
        }

        const normalized = normalizeOutputFormat(values[0]);
        if (!normalized) {
            return { present: true, error: 'output must be one of avif, webp, jpeg, jpg, png, gif' };
        }

        return { present: true, value: normalized };
    }

    if (defaultFormatMode === 'none') {
        return { present: false, value: null };
    }

    // 根据 Accept 自动选择的格式只是可选优化，标记为 implicit
    const value = resolvePreferredOutputFormat(acceptType);
    return { present: Boolean(value), value, implicit: Boolean(value) };
}

function normalizeDefaultFormatMode(value) {
    if (typeof value !== 'string') return 'auto';
    const normalized = value.trim().toLowerCase();
    return normalized === 'none' ? 'none' : 'auto';
}

function normalizeOutputFormat(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    return OUTPUT_FORMAT_BY_NAME.get(normalized) || null;
}

function resolvePreferredOutputFormat(acceptHeader) {
    if (!acceptHeader) return null;

    const entries = [];
    for (const item of acceptHeader.split(',')) {
        const [mediaType, ...params] = item.split(';').map(part => part.trim());
        const normalizedMediaType = (mediaType || '').trim().toLowerCase();
        if (!normalizedMediaType) continue;

        let qValue = 1;
        for (const param of params) {
            const [key, rawValue] = param.split('=').map(part => part.trim().toLowerCase());
            if (key === 'q' && rawValue) {
                const parsed = Number.parseFloat(rawValue);
                if (Number.isFinite(parsed)) qValue = parsed;
            }
        }

        if (normalizedMediaType === '*/*' || normalizedMediaType === 'image/*') {
            entries.push({ q: qValue, type: normalizedMediaType, priority: -1 });
            continue;
        }

        const normalizedFormat = normalizeOutputFormat(normalizedMediaType);
        if (!normalizedFormat) continue;
        entries.push({ q: qValue, type: normalizedFormat, priority: OUTPUT_FORMAT_PRIORITY.indexOf(normalizedFormat) });
    }

    const acceptedEntries = entries.filter(entry => entry.q > 0);
    if (acceptedEntries.length === 0) return null;
    acceptedEntries.sort((a, b) => {
        if (b.q !== a.q) return b.q - a.q;
        if (a.priority !== b.priority) return a.priority - b.priority;
        return 0;
    });

    const best = acceptedEntries[0];
    if (best.type === '*/*' || best.type === 'image/*') {
        return OUTPUT_FORMAT_PRIORITY[0];
    }
    return best.type;
}

function resolveOutputFormat(request, sourceType, requestedFormat) {
    if (requestedFormat) {
        return requestedFormat;
    }

    const acceptHeader = request?.headers?.get('Accept');
    const preferred = resolvePreferredOutputFormat(acceptHeader);
    if (preferred) {
        return preferred;
    }

    return OUTPUT_FORMATS.get(sourceType) || sourceType || null;
}

function mimeToTransformFormat(value) {
    if (!value) return null;
    const format = value.toLowerCase();
    if (format.startsWith('image/')) {
        return format.replace(/^image\//, '');
    }
    return format;
}

function parseAllowedSizes(value) {
    if (typeof value !== 'string' || value.trim() === '') return new Set();

    return new Set(
        value
            .split(',')
            .map(size => size.trim().toLowerCase())
            .filter(Boolean)
    );
}

function inferImageTypeFromFileName(fileName) {
    if (typeof fileName !== 'string') return null;

    const extension = getFileExtension(fileName);
    return extension ? IMAGE_TYPES_BY_EXTENSION.get(extension) || 'unknown' : null;
}

function parseContentLength(value) {
    if (!value || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function mergeTransformedHeaders(sourceHeaders, transformedHeaders, outputFormat) {
    const headers = new Headers(sourceHeaders);

    headers.delete('Content-Length');
    headers.delete('Content-Range');
    headers.delete('Accept-Ranges');
    headers.delete('ETag');
    removeVaryToken(headers, 'Range');
    addVaryToken(headers, 'Accept');

    for (const name of ['Content-Length', 'ETag']) {
        const value = transformedHeaders.get(name);
        if (value) headers.set(name, value);
    }

    headers.set('Content-Type', transformedHeaders.get('Content-Type') || outputFormat);
    return headers;
}

function removeVaryToken(headers, tokenToRemove) {
    const vary = headers.get('Vary');
    if (!vary) return;

    const remaining = vary
        .split(',')
        .map(token => token.trim())
        .filter(token => token && token.toLowerCase() !== tokenToRemove.toLowerCase());

    if (remaining.length > 0) {
        headers.set('Vary', remaining.join(', '));
    } else {
        headers.delete('Vary');
    }
}

function addVaryToken(headers, tokenToAdd) {
    const vary = headers.get('Vary');
    const values = vary ? vary.split(',').map(token => token.trim()).filter(Boolean) : [];
    const normalized = tokenToAdd.trim();
    if (!normalized) return;

    if (!values.some(token => token.toLowerCase() === normalized.toLowerCase())) {
        values.push(normalized);
        headers.set('Vary', values.join(', '));
    }
}

function imageTransformError(message, status, extraHeaders = {}) {
    return new Response(message, {
        status,
        headers: {
            'Content-Type': 'text/plain;charset=UTF-8',
            'Cache-Control': 'private, no-store, max-age=0',
            ...extraHeaders,
        },
    });
}
