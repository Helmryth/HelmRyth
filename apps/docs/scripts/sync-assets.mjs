import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const iconSource = fileURLToPath(new URL('../../../public/app-icon.svg', import.meta.url));
const iconTarget = fileURLToPath(new URL('../public/app-icon.svg', import.meta.url));

await mkdir(fileURLToPath(new URL('../public/', import.meta.url)), { recursive: true });
await copyFile(iconSource, iconTarget);
