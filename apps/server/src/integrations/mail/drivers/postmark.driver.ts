import { MailDriver } from './interfaces/mail-driver.interface';
import { PostmarkConfig } from '../interfaces';
import { ServerClient } from 'postmark';
import { MailMessage } from '../interfaces/mail.message';
import { Logger } from '@nestjs/common';
import { mailLogName } from '../mail.utils';

export class PostmarkDriver implements MailDriver {
  private readonly logger = new Logger(mailLogName(PostmarkDriver.name));
  private readonly postmarkClient: ServerClient;

  constructor(config: PostmarkConfig) {
    this.postmarkClient = new ServerClient(config.postmarkToken);
  }

  async sendMail(message: MailMessage): Promise<void> {
    try {
      await this.postmarkClient.sendEmail({
        From: message.from,
        To: message.to,
        Subject: message.subject,
        TextBody: message.text,
        HtmlBody: message.html,
      });
    } catch (err) {
      this.logger.warn({ to: message.to, err }, 'Failed to send mail');
      throw err;
    }
  }
}
