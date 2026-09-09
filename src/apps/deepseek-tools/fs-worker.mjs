// Runs only inside the tool isolate; native implementation and all file effects stay in that process.
import { Context, LocalFileSystem } from './sdk.mjs';
const fs = new LocalFileSystem(new Context(), { cwd: '/task/work', diffBasisMaxBytes: 1024 * 1024 });
const limit = 16 * 1024 * 1024;
process.stdin.setEncoding('utf8');
let request = '', size = 0;
try {
    for await (const part of process.stdin) {
        size += Buffer.byteLength(part);
        if (size > 2 * limit)
            throw new Error('FS_TOO_LARGE');
        request += part.toString('utf8');
    }
    const { method, args } = JSON.parse(request);
    if (!Array.isArray(args) || !['resolve', 'stat', 'lstat', 'readText', 'readBytes', 'listDir', 'writeText', 'editText'].includes(method))
        throw new Error('FS_IO_ERROR');
    let value;
    if (method === 'readText') {
        let text = '';
        for await (const part of await fs.streamText(args[0])) {
            size = Buffer.byteLength(text) + Buffer.byteLength(part);
            if (size > limit)
                throw new Error('FS_TOO_LARGE');
            text += part;
        }
        value = text;
    }
    else if (method === 'readBytes') {
        const max = args[1];
        if (!Number.isSafeInteger(max) || max < 1)
            throw new Error('FS_TOO_LARGE');
        value = Buffer.from(await fs.readBytes(args[0], undefined, Math.min(limit, max))).toString('base64');
    }
    else
        value = await fs[method](...args);
    const response = JSON.stringify({ ok: true, value });
    if (Buffer.byteLength(response) > 2 * limit)
        throw new Error('FS_TOO_LARGE');
    process.stdout.write(response);
}
catch (error) {
    const native = error;
    const code = typeof native.code === 'string' && /^FS_[A-Z_]+$/.test(native.code) ? native.code
        : native.message === 'FS_TOO_LARGE' ? 'FS_TOO_LARGE' : 'FS_IO_ERROR';
    process.stdout.write(JSON.stringify({ ok: false, code }));
}
export {};
