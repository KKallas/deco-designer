/** Program libraries in this browser (docs/14-shapes.md, docs/30 §5): profiles in `deco/shape-library`, fills in `deco/fill-library`. */
import type { Fill, Profile } from '../model/types';
import { createLibrary } from '../app/library';

export const shapeLibrary = createLibrary<Profile>('deco/shape-library', (x) => (typeof x.code === 'string' ? { ...x, label: x.label ?? x.id, params: x.params ?? {}, color: x.color ?? '#c9c9cf', limits: { minBendRadius: x.limits?.minBendRadius ?? 0, maxLength: x.limits?.maxLength ?? 6000 } } : null));

export const fillLibrary = createLibrary<Fill>('deco/fill-library', (x) => (typeof x.code === 'string' ? { id: x.id, label: x.label ?? x.id, code: x.code, params: x.params ?? {}, color: x.color ?? '#d8d8dc', metalness: x.metalness ?? 0, roughness: x.roughness ?? 0.5 } : null));
