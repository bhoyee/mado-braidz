import mjml from 'mjml';
import { readFileSync, writeFileSync } from 'node:fs';
const source = readFileSync('src/views/emails/layout.mjml', 'utf8');
const result = await mjml(source, { validationLevel: 'strict', minify: false });
if (result.errors?.length) throw new Error('Email template compilation failed');
writeFileSync('src/views/emails/layout.html.njk', result.html);
