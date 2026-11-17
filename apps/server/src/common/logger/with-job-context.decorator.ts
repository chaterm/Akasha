import { runWithJobContext } from './job-context';

export function WithJobContext(jobName?: string): MethodDecorator {
  return (target, propertyKey, descriptor: PropertyDescriptor) => {
    const original = descriptor.value;
    const name =
      jobName ??
      `${target?.constructor?.name ?? ''}.${String(propertyKey)}`.replace(
        /^\./,
        '',
      );

    descriptor.value = function (...args: unknown[]) {
      return runWithJobContext({ jobId: '', jobName: name }, async () =>
        original.apply(this, args),
      );
    };

    return descriptor;
  };
}
