import { prisma } from '../../db.js';
import type {
  TaskCreateInput,
  TaskUpdateInput,
  TaskFilters,
  TaskWithEvents,
  TaskOperationResult,
} from './types.js';
import type { TaskEvent } from '@prisma/client';

export class TaskManager {
  /**
   * Create a new task
   */
  async createTask(input: TaskCreateInput): Promise<TaskOperationResult> {
    try {
      const task = await prisma.task.create({
        data: {
          title: input.title,
          description: input.description,
          priority: input.priority ?? 0,
          due_date: input.dueDate,
          estimated_hours: input.estimatedHours,
          chat_id: input.chatId,
          parent_id: input.parentId,
          metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        },
      });

      // Handle dependencies if provided
      if (input.dependencies && input.dependencies.length > 0) {
        await prisma.taskDependency.createMany({
          data: input.dependencies.map(depId => ({
            task_id: task.id,
            dependency_id: depId,
          })),
        });
      }

      // Create initial event
      await this.createTaskEvent(task.id, 'created', { title: task.title });

      return {
        success: true,
        task: {
          ...task,
          events: [],
          children: [],
          dependencies: input.dependencies,
        } as TaskWithEvents,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create task',
      };
    }
  }

  /**
   * Get a task by ID
   */
  async getTaskById(taskId: string): Promise<TaskOperationResult> {
    try {
      const task = await prisma.task.findUnique({
        where: { id: taskId },
      });

      if (!task) {
        return {
          success: false,
          error: 'Task not found',
        };
      }

      return {
        success: true,
        task: {
          ...task,
          events: [],
          children: [],
        } as TaskWithEvents,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get task',
      };
    }
  }

  /**
   * List tasks with filters
   */
  async listTasks(filters: TaskFilters = {}): Promise<TaskOperationResult> {
    try {
      const where: any = {};

      if (filters.status) {
        where.status = filters.status;
      }

      if (filters.priority !== undefined) {
        where.priority = filters.priority;
      }

      if (filters.chatId) {
        where.chat_id = filters.chatId;
      }

      if (filters.parentId) {
        where.parent_id = filters.parentId;
      }

      if (filters.createdAfter) {
        where.created_at = { gte: filters.createdAfter };
      }

      if (filters.createdBefore) {
        where.created_at = { lte: filters.createdBefore };
      }

      if (filters.dueAfter) {
        where.due_date = { gte: filters.dueAfter };
      }

      if (filters.dueBefore) {
        where.due_date = { lte: filters.dueBefore };
      }

      const tasks = await prisma.task.findMany({
        where,
        orderBy: [
          { priority: 'desc' },
          { created_at: 'desc' },
        ],
              });

      return {
        success: true,
        tasks: tasks as TaskWithEvents[],
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list tasks',
      };
    }
  }

  /**
   * Update a task
   */
  async updateTask(taskId: string, input: TaskUpdateInput): Promise<TaskOperationResult> {
    try {
      // Get current task for change detection
      const currentTask = await prisma.task.findUnique({
        where: { id: taskId },
        select: { status: true, title: true },
      });

      if (!currentTask) {
        return {
          success: false,
          error: 'Task not found',
        };
      }

      const updateData: any = {
        ...input,
        metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
      };

      // Only update completedAt if status is changing to COMPLETED
      if (input.status === 'COMPLETED' && currentTask.status !== 'COMPLETED') {
        updateData.completed_at = new Date();
      }

      const task = await prisma.task.update({
        where: { id: taskId },
        data: updateData,
      });

      // Create events for status changes
      if (input.status && input.status !== currentTask.status) {
        await this.createTaskEvent(task.id, 'status_changed', {
          from: currentTask.status,
          to: input.status,
        });
      }

      if (input.title && input.title !== currentTask.title) {
        await this.createTaskEvent(task.id, 'title_changed', {
          from: currentTask.title,
          to: input.title,
        });
      }

      return {
        success: true,
        task: {
          ...task,
          events: [],
          children: [],
        } as TaskWithEvents,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update task',
      };
    }
  }

  /**
   * Delete a task
   */
  async deleteTask(taskId: string): Promise<TaskOperationResult> {
    try {
      // Delete all child tasks first (cascade delete will handle this)
      await prisma.task.delete({
        where: { id: taskId },
      });

      return {
        success: true,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete task',
      };
    }
  }

  /**
   * Mark task as in progress
   */
  async startTask(taskId: string): Promise<TaskOperationResult> {
    return this.updateTask(taskId, { status: 'IN_PROGRESS' });
  }

  /**
   * Complete a task
   */
  async completeTask(taskId: string): Promise<TaskOperationResult> {
    return this.updateTask(taskId, { status: 'COMPLETED' });
  }

  /**
   * Cancel a task
   */
  async cancelTask(taskId: string): Promise<TaskOperationResult> {
    return this.updateTask(taskId, { status: 'CANCELLED' });
  }

  /**
   * Create a subtask
   */
  async createSubtask(
    parentId: string,
    input: Omit<TaskCreateInput, 'parentId'>
  ): Promise<TaskOperationResult> {
    return this.createTask({
      ...input,
      parentId,
    });
  }

  /**
   * Add dependencies to a task
   */
  async addDependencies(taskId: string, dependencyIds: string[]): Promise<TaskOperationResult> {
    try {
      // Check if all dependencies exist
      const existingTasks = await prisma.task.findMany({
        where: {
          id: { in: dependencyIds },
        },
      });

      if (existingTasks.length !== dependencyIds.length) {
        return {
          success: false,
          error: 'One or more dependencies not found',
        };
      }

      // Add dependencies (insert individually to handle duplicates gracefully)
      for (const depId of dependencyIds) {
        try {
          await prisma.taskDependency.create({
            data: {
              task_id: taskId,
              dependency_id: depId,
            },
          });
        } catch {
          // Skip duplicate dependencies
        }
      }

      return {
        success: true,
        message: `Added ${dependencyIds.length} dependencies to task ${taskId}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add dependencies',
      };
    }
  }

  /**
   * Remove dependencies from a task
   */
  async removeDependencies(taskId: string, dependencyIds: string[]): Promise<TaskOperationResult> {
    try {
      await prisma.taskDependency.deleteMany({
        where: {
          task_id: taskId,
          dependency_id: { in: dependencyIds },
        },
      });

      return {
        success: true,
        message: `Removed ${dependencyIds.length} dependencies from task ${taskId}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to remove dependencies',
      };
    }
  }

  /**
   * Get task dependencies
   */
  async getTaskDependencies(taskId: string): Promise<TaskOperationResult> {
    try {
      const dependencies = await prisma.taskDependency.findMany({
        where: { task_id: taskId },
        include: {
          dependency: true,
        },
      });

      return {
        success: true,
        dependencies: dependencies.map(d => d.dependency),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get dependencies',
      };
    }
  }

  /**
   * Get task dependents
   */
  async getTaskDependents(taskId: string): Promise<TaskOperationResult> {
    try {
      const dependents = await prisma.taskDependency.findMany({
        where: { dependency_id: taskId },
        include: {
          task: true,
        },
      });

      return {
        success: true,
        dependents: dependents.map(d => d.task),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get dependents',
      };
    }
  }

  /**
   * Get task hierarchy (all descendants)
   */
  async getTaskHierarchy(taskId: string): Promise<TaskOperationResult> {
    try {
      const task = await prisma.task.findUnique({
        where: { id: taskId },
        include: {
          subtasks: {
            include: {
              subtasks: true,
            },
          },
        },
      });

      if (!task) {
        return {
          success: false,
          error: 'Task not found',
        };
      }

      return {
        success: true,
        task: {
          ...task,
          events: [],
          children: (task.subtasks || []) as any[],
        } as TaskWithEvents,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get task hierarchy',
      };
    }
  }

  /**
   * Create a task event
   */
  private async createTaskEvent(
    taskId: string,
    type: string,
    data?: any
  ): Promise<TaskEvent> {
    return prisma.taskEvent.create({
      data: {
        taskId,
        type,
        data: data ? JSON.stringify(data) : null,
      },
    });
  }

  /**
   * Get task analytics
   */
  async getTaskAnalytics(chatId?: string) {
    const where: any = {};
    if (chatId) {
      where.chat_id = chatId;
    }

    const [
      totalTasks,
      pendingTasks,
      inProgressTasks,
      completedTasks,
      cancelledTasks,
      avgPriority,
    ] = await Promise.all([
      prisma.task.count({ where }),
      prisma.task.count({ where: { ...where, status: 'PENDING' } }),
      prisma.task.count({ where: { ...where, status: 'IN_PROGRESS' } }),
      prisma.task.count({ where: { ...where, status: 'COMPLETED' } }),
      prisma.task.count({ where: { ...where, status: 'CANCELLED' } }),
      prisma.task.aggregate({
        where,
        _avg: { priority: true },
      }),
    ]);

    return {
      total: totalTasks,
      pending: pendingTasks,
      inProgress: inProgressTasks,
      completed: completedTasks,
      cancelled: cancelledTasks,
      averagePriority: avgPriority._avg.priority || 0,
    };
  }
}