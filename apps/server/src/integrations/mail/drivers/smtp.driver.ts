import { MailDriver } from './interfaces/mail-driver.interface';
import { SMTPConfig } from '../interfaces';
import { Transporter } from 'nodemailer';
import * as nodemailer from 'nodemailer';
import { MailMessage } from '../interfaces/mail.message';
import { Logger } from '@nestjs/common';
import { mailLogName } from '../mail.utils';

export class SmtpDriver implements MailDriver {
  private readonly logger = new Logger(mailLogName(SmtpDriver.name));
  private readonly transporter: Transporter;

  constructor(config: SMTPConfig) {
    this.transporter = nodemailer.createTransport(config);
  }

  async sendMail(message: MailMessage): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    } catch (err) {
      this.logger.warn({ to: message.to, err }, 'Failed to send mail');
      throw err;
    }
  }
}
