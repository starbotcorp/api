import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { projectRoutes } from '../projects.js';

describe('Project Routes', () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(projectRoutes, { prefix: '/v1' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /v1/projects', () => {
    it('should create a new project', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: {
          name: 'Test Project',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.project).toBeDefined();
      expect(body.project.name).toBe('Test Project');
      expect(body.project.id).toBeDefined();
    });

    it('should reject empty project name', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: {
          name: '',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /v1/projects', () => {
    it('should list all projects', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/projects',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.projects).toBeDefined();
      expect(Array.isArray(body.projects)).toBe(true);
    });
  });

  describe('GET /v1/projects/:id', () => {
    it('should return 404 for non-existent project', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/projects/non-existent-id',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('PUT /v1/projects/:id', () => {
    it('should update project name', async () => {
      // First create a project
      const createResponse = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Original Name' },
      });

      const { project } = JSON.parse(createResponse.body);

      // Then update it
      const updateResponse = await app.inject({
        method: 'PUT',
        url: `/v1/projects/${project.id}`,
        payload: { name: 'Updated Name' },
      });

      expect(updateResponse.statusCode).toBe(200);
      const body = JSON.parse(updateResponse.body);
      expect(body.project.name).toBe('Updated Name');
    });
  });

  describe('DELETE /v1/projects/:id', () => {
    it('should delete a project', async () => {
      // First create a project
      const createResponse = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'To Delete' },
      });

      const { project } = JSON.parse(createResponse.body);

      // Then delete it
      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: `/v1/projects/${project.id}`,
      });

      expect(deleteResponse.statusCode).toBe(200);
      const body = JSON.parse(deleteResponse.body);
      expect(body.ok).toBe(true);

      // Verify it's gone
      const getResponse = await app.inject({
        method: 'GET',
        url: `/v1/projects/${project.id}`,
      });

      expect(getResponse.statusCode).toBe(404);
    });
  });
});
