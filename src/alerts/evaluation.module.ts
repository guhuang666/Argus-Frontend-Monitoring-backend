import { Module } from '@nestjs/common';
import { AlertDeliveryService } from './alert-delivery.service';
import { AlertEvaluatorService } from './alert-evaluator.service';
import { EvaluatorLock } from './evaluator-lock';

/**
 * 告警评估（M6-3 / M6-4 最小投递）。
 *
 * ⚠️ 只被 worker.ts 的 WorkerModule import，**绝不进 app.module.ts**。
 * 理由与 grouping/ 完全相同：本模块里有"每 60 秒自己醒来"的循环，
 * 一旦进入 API 进程，每个 API 副本都会开始评估、各发一条消息。
 * 反过来，AlertsModule（CRUD）也不被 worker import —— 那边是人在改配置。
 *
 * 两个模块共享同一张 `alert_rules` 表，但没有代码依赖：
 * 写的一方不关心谁来评估，评估的一方不关心规则是怎么被创建的。
 */
@Module({
  providers: [AlertEvaluatorService, AlertDeliveryService, EvaluatorLock],
})
export class EvaluationModule {}
