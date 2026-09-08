/** Post-processing script library in this browser (docs/15-camera.md): `deco/post-library`. */
import { createLibrary } from '../app/library';

export interface PostEntry { id: string; label: string; code: string; params: Record<string, number> }

export const postLibrary = createLibrary<PostEntry>('deco/post-library', (x) => (typeof x.code === 'string' ? { ...x, label: x.label ?? x.id, params: x.params ?? {} } : null));
