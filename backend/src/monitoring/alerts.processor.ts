import { Processor, WorkerHost } from '@nestjs/bullmq';
import { AlertService } from './alert.service';
import { MONITORAMENTO_QUEUE } from './monitoring.keys';

/** Worker do job periódico de alertas: avalia as regras e avisa o que mudou. */
@Processor(MONITORAMENTO_QUEUE)
export class AlertsProcessor extends WorkerHost {
  constructor(private readonly alerts: AlertService) {
    super();
  }

  async process(): Promise<void> {
    await this.alerts.executar();
  }
}
