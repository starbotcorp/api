import type { Task, TaskEvent } from '@prisma/client';

export interface TaskCreateInput {
  title: string;
  description?: string;
  priority?: number;
  dueDate?: Date;
  estimatedHours?: number;
  chatId?: string;
  parentId?: string;
  dependencies?: string[];
  metadata?: any;
}

export type TaskStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export interface TaskUpdateInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
  dueDate?: Date;
  estimatedHours?: number;
  actualHours?: number;
  metadata?: any;
  completedAt?: Date;
}

export interface TaskFilters {
  status?: TaskStatus;
  priority?: number;
  chatId?: string;
  parentId?: string;
  createdAfter?: Date;
  createdBefore?: Date;
  dueAfter?: Date;
  dueBefore?: Date;
}

export interface TaskWithEvents {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: number;
  due_date?: Date;
  estimated_hours?: number;
  actual_hours?: number;
  parent_id?: string;
  chat_id?: string;
  metadata?: any;
  created_at: Date;
  updated_at: Date;
  completed_at?: Date;
  events?: TaskEvent[];
  children?: TaskWithEvents[];
  dependencies?: string[];
}

export interface TaskOperationResult {
  success: boolean;
  task?: TaskWithEvents;
  tasks?: TaskWithEvents[];
  error?: string;
  message?: string;
  events?: TaskEvent[];
  dependencies?: any[];
  dependents?: any[];
}