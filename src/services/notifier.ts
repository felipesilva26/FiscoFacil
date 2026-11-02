import nodemailer from 'nodemailer';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Notifier {
  send(mail: Mail): Promise<void>;
}

/** Guarda os e-mails em memória. Usado nos testes. */
export class MemoryNotifier implements Notifier {
  outbox: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.outbox.push(mail);
  }
}

/** Sem SMTP configurado: só escreve no log do servidor. */
export class ConsoleNotifier implements Notifier {
  async send(mail: Mail): Promise<void> {
    console.log(`[e-mail simulado] para ${mail.to}: ${mail.subject}\n${mail.text}`);
  }
}

export class SmtpNotifier implements Notifier {
  private transport;
  constructor(smtpUrl: string, private from: string) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }
  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text });
  }
}
