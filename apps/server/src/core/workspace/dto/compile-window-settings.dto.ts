import {
  IsBoolean,
  IsString,
  Matches,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

@ValidatorConstraint({ name: 'distinctFromStartTime', async: false })
class DistinctFromStartTimeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments) {
    return value !== (args.object as UpdateCompileWindowSettingsDto).startTime;
  }

  defaultMessage() {
    return 'endTime must differ from startTime';
  }
}

/** Times are HH:mm in the server's local timezone. */
export class UpdateCompileWindowSettingsDto {
  @IsBoolean()
  enabled: boolean;

  @IsString()
  @Matches(TIME_PATTERN, { message: 'startTime must be HH:mm' })
  startTime: string;

  @IsString()
  @Matches(TIME_PATTERN, { message: 'endTime must be HH:mm' })
  @Validate(DistinctFromStartTimeConstraint)
  endTime: string;
}
