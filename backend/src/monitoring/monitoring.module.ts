import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ANALISES_QUEUE } from '../analysis/analysis-queue.service';
import { AlertService } from './alert.service';
import { AlertsProcessor } from './alerts.processor';
import { MONITORAMENTO_QUEUE } from './monitoring.keys';

@Module({
  imports: [
    BullModule.registerQueue({ name: MONITORAMENTO_QUEUE }),
    // A fila de análises também é consultada (tamanho da fila de espera).
    BullModule.registerQueue({ name: ANALISES_QUEUE }),
  ],
  providers: [AlertService, AlertsProcessor],
})
export class MonitoringModule {}
