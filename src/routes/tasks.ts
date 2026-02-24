import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { TaskManager } from '../services/task-manager/index.js';

const taskManager = new TaskManager();

// Task creation schema
const CreateTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  priority: z.number().min(0).max(10).optional().default(0),
  chat_id: z.string().optional(),
  parent_id: z.string().optional(),
  metadata: z.any().optional(),
});

// Task update schema
const UpdateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
  priority: z.number().min(0).max(10).optional(),
  metadata: z.any().optional(),
});

// Task filters schema
const ListTasksSchema = z.object({
  status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
  priority: z.number().min(0).max(10).optional(),
  chat_id: z.string().optional(),
  parent_id: z.string().optional(),
  created_after: z.string().optional(),
  created_before: z.string().optional(),
  page: z.number().min(1).optional().default(1),
  limit: z.number().min(1).max(100).optional().default(20),
}).strict();

export const tasksRoutes = async (fastify: FastifyInstance) => {
  // Get all tasks
  fastify.get('/tasks', {
    handler: async (request, reply) => {
      const {
        status,
        priority,
        chat_id,
        parent_id,
        created_after,
        created_before,
        page = 1,
        limit = 20,
      } = request.query as any;

      try {
        const filters = {
          status,
          priority,
          chat_id,
          parent_id,
          createdAfter: created_after ? new Date(created_after) : undefined,
          createdBefore: created_before ? new Date(created_before) : undefined,
        };

        const result = await taskManager.listTasks(filters);

        if (!result.success) {
          reply.code(400).send(result);
          return;
        }

        // Calculate pagination
        const totalCount = await prisma.task.count({
          where: {
            status: status ? { equals: status } : undefined,
            priority: priority !== undefined ? { equals: priority } : undefined,
            chat_id: chat_id ? { equals: chat_id } : undefined,
            parent_id: parent_id ? { equals: parent_id } : undefined,
            created_at: {
              gte: created_after ? new Date(created_after) : undefined,
              lte: created_before ? new Date(created_before) : undefined,
            },
          },
        });

        const offset = (page - 1) * limit;

        const tasks = result.tasks || [];
        const paginatedTasks = tasks.slice(offset, offset + limit);

        reply.code(200).send({
          success: true,
          data: paginatedTasks,
          pagination: {
            page,
            limit,
            total: totalCount,
          },
        });
      } catch (error) {
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list tasks',
        });
      }
    },
  });

  // Get task by ID
  fastify.get('/tasks/:id', {
    handler: async (request: any, reply) => {
      const { id } = request.params as { id: string };

      try {
        const result = await taskManager.getTaskById(id);

        if (!result.success) {
          reply.code(404).send(result);
          return;
        }

        reply.code(200).send(result);
      } catch (error) {
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get task',
        });
      }
    },
  });

  // Create task
  fastify.post('/tasks', {
    handler: async (request, reply) => {
      try {
        const parsed = CreateTaskSchema.safeParse(request.body);
        if (!parsed.success) {
          reply.code(400).send({
            success: false,
            error: 'Validation failed',
            details: parsed.error.issues,
          });
          return;
        }
        const taskData = parsed.data;

        const result = await taskManager.createTask(taskData);

        if (!result.success) {
          reply.code(400).send(result);
          return;
        }

        reply.code(201).send(result);
      } catch (error) {
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create task',
        });
      }
    },
  });

  // Update task
  fastify.put('/tasks/:id', {
    handler: async (request: any, reply) => {
      const { id } = request.params as { id: string };

      try {
        const parsed = UpdateTaskSchema.safeParse(request.body);
        if (!parsed.success) {
          reply.code(400).send({
            success: false,
            error: 'Validation failed',
            details: parsed.error.issues,
          });
          return;
        }
        const updateData = parsed.data;

        const result = await taskManager.updateTask(id, updateData);

        if (!result.success) {
          reply.code(400).send(result);
          return;
        }

        reply.code(200).send(result);
      } catch (error) {
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update task',
        });
      }
    },
  });

  // Delete task
  fastify.delete('/tasks/:id', {
    handler: async (request: any, reply) => {
      const { id } = request.params as { id: string };

      try {
        const result = await taskManager.deleteTask(id);

        if (!result.success) {
          reply.code(400).send(result);
          return;
        }

        reply.code(200).send({
          success: true,
          message: 'Task deleted successfully',
        });
      } catch (error) {
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete task',
        });
      }
    },
  });

  // Task action endpoints
  fastify.post('/tasks/:id/start', {
    handler: async (request: any, reply) => {
      const { id } = request.params as { id: string };

      try {
        const result = await taskManager.startTask(id);

        if (!result.success) {
          reply.code(400).send(result);
          return;
        }

        reply.code(200).send(result);
      } catch (error) {
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to start task',
        });
      }
    },
  });

  fastify.post('/tasks/:id/complete', {
    handler: async (request: any, reply) => {
      const { id } = request.params as { id: string };

      try {
        const result = await taskManager.completeTask(id);

        if (!result.success) {
          reply.code(400).send(result);
          return;
        }

        reply.code(200).send(result);
      } catch (error) {
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to complete task',
        });
      }
    },
  });

  fastify.post('/tasks/:id/cancel', {
    handler: async (request: any, reply) => {
      const { id } = request.params as { id: string };

      try {
        const result = await taskManager.cancelTask(id);

        if (!result.success) {
          reply.code(400).send(result);
          return;
        }

        reply.code(200).send(result);
      } catch (error) {
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to cancel task',
        });
      }
    },
  });

  // Create subtask
  fastify.post('/tasks/:id/subtasks', {
    handler: async (request: any, reply) => {
      const { id } = request.params as { id: string };
      const subtaskData = request.body as any;

      try {
        const result = await taskManager.createSubtask(id, subtaskData);

        if (!result.success) {
          reply.code(400).send(result);
          return;
        }

        reply.code(201).send(result);
      } catch (error) {
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create subtask',
        });
      }
    },
  });

  // Get task hierarchy
  fastify.get('/tasks/:id/hierarchy', {
    handler: async (request: any, reply) => {
      const { id } = request.params as { id: string };

      try {
        const result = await taskManager.getTaskHierarchy(id);

        if (!result.success) {
          reply.code(404).send(result);
          return;
        }

        reply.code(200).send(result);
      } catch (error) {
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get task hierarchy',
        });
      }
    },
  });

  // Add dependencies to a task
  fastify.post('/tasks/:taskId/dependencies', {
    handler: async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const { dependencies } = request.body as { dependencies: string[] };

      try {
        const result = await taskManager.addDependencies(taskId, dependencies);

        reply.code(result.success ? 200 : 404).send(result);
      } catch (error) {
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to add dependencies',
        });
      }
    },
  });

  // Remove dependencies from a task
  fastify.delete('/tasks/:taskId/dependencies', {
    handler: async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const { dependencies } = request.body as { dependencies: string[] };

      try {
        const result = await taskManager.removeDependencies(taskId, dependencies);

        reply.code(200).send(result);
      } catch (error) {
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to remove dependencies',
        });
      }
    },
  });

  // Get task dependencies
  fastify.get('/tasks/:taskId/dependencies', {
    handler: async (request, reply) => {
      const { taskId } = request.params as { taskId: string };

      try {
        const result = await taskManager.getTaskDependencies(taskId);

        reply.code(200).send(result);
      } catch (error) {
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get dependencies',
        });
      }
    },
  });

  // Get task dependents
  fastify.get('/tasks/:taskId/dependents', {
    handler: async (request, reply) => {
      const { taskId } = request.params as { taskId: string };

      try {
        const result = await taskManager.getTaskDependents(taskId);

        reply.code(200).send(result);
      } catch (error) {
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get dependents',
        });
      }
    },
  });

  // Get task analytics
  fastify.get('/tasks/analytics', {
    handler: async (request, reply) => {
      const { chat_id } = request.query as { chat_id?: string };

      try {
        const analytics = await taskManager.getTaskAnalytics(chat_id);

        reply.code(200).send({
          success: true,
          data: analytics,
        });
      } catch (error) {
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get task analytics',
        });
      }
    },
  });
};