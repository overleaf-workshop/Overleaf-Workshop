/* eslint-disable @typescript-eslint/naming-convention */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Response } from 'undici';
import { BaseAPI } from '../api/base';

test('BaseAPI encodes uploads as multipart and ordinary POSTs as JSON', async (t) => {
    const requests: {url: string, contentType: string, csrf: string | undefined, body: Buffer}[] = [];
    const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(Buffer.from(chunk));
        }
        requests.push({
            url: req.url!,
            contentType: req.headers['content-type']!,
            csrf: req.headers['x-csrf-token'] as string | undefined,
            body: Buffer.concat(chunks),
        });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({success: true, entity_id: 'file', entity_type: 'file', project_id: 'project', _id: 'folder'}));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
    }));
    const api = new BaseAPI(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    const identity = {csrfToken: 'test-csrf', cookies: 'session=test'};

    await t.test('file upload preserves fields, filename, and binary bytes', async () => {
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 13, 10]);
        const filename = 'figure with spaces.png';
        const result = await api.uploadFile(identity, 'project', 'folder', filename, bytes);
        assert.equal(result.type, 'success');
        const request = requests.shift()!;
        assert.equal(request.url, '/project/project/upload?folder_id=folder');
        assert.equal(request.csrf, identity.csrfToken);
        assert.match(request.contentType, /^multipart\/form-data; boundary=/);
        const form = await new Response(request.body, {headers: {'Content-Type': request.contentType}}).formData();
        assert.equal(form.get('targetFolderId'), 'folder');
        assert.equal(form.get('name'), filename);
        assert.equal(form.get('type'), 'image/png');
        const file = form.get('qqfile');
        assert.ok(file && typeof file !== 'string');
        assert.equal(file.name, filename);
        assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
    });

    await t.test('project upload preserves ZIP bytes and metadata', async () => {
        const bytes = new Uint8Array([0x50, 0x4b, 3, 4, 0, 0xff]);
        const result = await api.uploadProject(identity, 'project.zip', bytes);
        assert.equal(result.type, 'success');
        const request = requests.shift()!;
        const url = new URL(request.url, 'http://localhost');
        assert.equal(url.pathname, '/project/new/upload');
        assert.equal(url.searchParams.get('_csrf'), identity.csrfToken);
        assert.equal(url.searchParams.get('qqfilename'), 'project.zip');
        assert.equal(url.searchParams.get('qqtotalfilesize'), String(bytes.length));
        assert.ok(url.searchParams.get('qquuid'));
        assert.match(request.contentType, /^multipart\/form-data; boundary=/);
        const form = await new Response(request.body, {headers: {'Content-Type': request.contentType}}).formData();
        const file = form.get('qqfile');
        assert.ok(file && typeof file !== 'string');
        assert.equal(file.name, 'project.zip');
        assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
    });

    await t.test('ordinary POSTs retain JSON encoding and CSRF body', async () => {
        const result = await api.addFolder(identity, 'project', 'figures', 'folder');
        assert.equal(result.type, 'success');
        const request = requests.shift()!;
        assert.equal(request.contentType, 'application/json');
        assert.deepEqual(JSON.parse(request.body.toString()), {
            _csrf: identity.csrfToken, parent_folder_id: 'folder', name: 'figures',
        });
    });
});
