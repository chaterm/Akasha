import { AnyObject } from './types';

export function getFromPath(obj: AnyObject, path: string): any {
  const pathParts = path.split('/');
  pathParts.shift();
  while (pathParts.length) {
    const property = pathParts.shift();
    obj = obj[property];
  }
  return obj;
}
