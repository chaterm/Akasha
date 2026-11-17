import isISO6391Validator from 'validator/lib/isISO6391';
import { buildMessage, ValidateBy, ValidationOptions } from 'class-validator';

export const IS_ISO6391 = 'isISO6391';

export function isISO6391(value: unknown): boolean {
  return typeof value === 'string' && isISO6391Validator(value);
}

export function IsISO6391(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: IS_ISO6391,
      validator: {
        validate: (value, args): boolean => isISO6391(value),
        defaultMessage: buildMessage(
          (eachPrefix) =>
            eachPrefix + '$property must be a valid ISO 639-1 language code',
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}
