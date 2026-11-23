import { z } from 'zod';
import { checked } from './managementValidation.js';
import { ManagementError } from './managementErrors.js';
export function photoPlacement(body) {
  if (body.placementFields !== '1')
    return { kind: z.enum(['style', 'gallery']).parse(body.kind) };
  const style = checked.parse(body.showOnStyle);
  const work = checked.parse(body.showInWork);
  if (!style && !work)
    throw new ManagementError('Choose where to show this photo.');
  return { kind: style ? 'style' : 'gallery', showInWork: work };
}
