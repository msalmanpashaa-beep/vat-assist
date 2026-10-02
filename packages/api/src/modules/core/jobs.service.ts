import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { AppConfig } from '../../config';

type Handler = (data: Record<string, unknown>) => Promise<void>;

/**
 * Background jobs. With REDIS_URL set, jobs go through BullMQ with retries and a 15-minute reminder
 * scheduler. Without it (development, the demo) jobs run inline so the flow stays easy to follow.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Jobs');
  private readonly handlers = new Map<string, Handler>();
  private queue?: Queue;
  private worker?: Worker;
  private connection?: Redis;

  constructor(private readonly cfg: AppConfig) {}

  register(name: string, handler: Handler): void {
    this.handlers.set(name, handler);
  }

  get inline(): boolean {
    return !this.cfg.env.REDIS_URL;
  }

  async enqueue(name: string, data: Record<string, unknown>): Promise<void> {
    if (this.queue) {
      await this.queue.add(name, data, {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      });
      return;
    }
    await this.run(name, data);
  }

  private async run(name: string, data: Record<string, unknown>): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`No handler for job ${name}`);
    await handler(data);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.cfg.env.REDIS_URL) return;
    this.connection = new Redis(this.cfg.env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue('vat-assist', { connection: this.connection });
    this.worker = new Worker('vat-assist', async (job) => this.run(job.name, job.data as Record<string, unknown>), {
      connection: this.connection,
      concurrency: 4,
    });
    this.worker.on('failed', (job, err) => this.log.error(`job ${job?.name} failed: ${err.message}`));
    await this.queue.upsertJobScheduler('reminders-tick', { every: 15 * 60 * 1000 }, { name: 'reminders.tick', data: {} });
    this.log.log('BullMQ worker and reminder scheduler started');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.connection?.disconnect();
  }
}
