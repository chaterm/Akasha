export function transpose<T>(array: T[][]): T[][] {
  return array[0].map((_, i) => {
    return array.map((column) => column[i]);
  });
}
