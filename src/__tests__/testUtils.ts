import fs from 'fs';
import path from 'path';

export function loadDefaultConfig() {
    const jsonPath = path.resolve(process.cwd(), 'config', 'default.json');
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

export function disabled(a: any, b: any) { }