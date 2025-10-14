import mongoose, { Schema } from 'mongoose';
import { hostname } from 'os';

import type { ObjectId } from '.';

export interface IDistributedLock {
  _id: ObjectId;
  lockName: string; // 锁的名称/标识符 (如: "check-alerts")
  lockValue: string; // 锁持有者的唯一标识 (pod name)
  acquiredAt: Date; // 获取锁的时间
  expiresAt: Date; // 锁过期时间
}

export type DistributedLockDocument =
  mongoose.HydratedDocument<IDistributedLock>;

const DistributedLockSchema = new Schema<IDistributedLock>(
  {
    lockName: {
      type: String,
      required: true,
      unique: true, // 锁名称必须唯一，这样才能实现真正的互斥
      index: true,
    },
    lockValue: {
      type: String,
      required: true,
      index: true,
    },
    acquiredAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 }, // MongoDB TTL 索引，自动清理过期文档
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
  },
);

interface DistributedLockModel extends mongoose.Model<IDistributedLock> {
  acquireLock(ttlSeconds?: number): Promise<boolean>;
  releaseLock(): Promise<boolean>;
}

const lockName = 'check-alerts';

// 获取锁
DistributedLockSchema.statics.acquireLock = async function (
  ttlSeconds: number = 120, // 默认2分钟
): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const currentPodName = process.env.HOSTNAME || hostname();

  try {
    // 检查指定名称的锁是否已经存在
    const existingLock = await this.findOne({ lockName });

    if (existingLock) {
      // 如果锁已过期，删除它
      if (existingLock.expiresAt < now) {
        await this.deleteOne({ _id: existingLock._id });
      } else {
        // 锁还有效，检查是否是当前 pod 持有
        if (existingLock.lockValue === currentPodName) {
          // 当前 pod 持有锁，延长过期时间
          await this.updateOne(
            { _id: existingLock._id },
            { $set: { expiresAt } },
          );
          return true;
        } else {
          // 其他 pod 持有锁，返回 false
          return false;
        }
      }
    }

    // 没有锁或锁已过期，尝试创建新锁
    const newLock = await this.create({
      lockName,
      lockValue: currentPodName,
      acquiredAt: now,
      expiresAt,
    });

    return !!newLock;
  } catch (error: any) {
    // 如果是重复键错误，说明在检查和创建之间有其他实例创建了锁
    if (error.code === 11000) {
      return false;
    }
    throw error;
  }
};

// 释放锁
DistributedLockSchema.statics.releaseLock =
  async function (): Promise<boolean> {
    const currentPodName = process.env.HOSTNAME || hostname();

    try {
      // 只删除当前 pod 持有的锁
      const result = await this.deleteOne({ lockValue: currentPodName });
      return result.deletedCount > 0;
    } catch (error) {
      console.error('Error releasing distributed lock:', error);
      return false;
    }
  };

export default mongoose.model<IDistributedLock, DistributedLockModel>(
  'DistributedLock',
  DistributedLockSchema,
);
