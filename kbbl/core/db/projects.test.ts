import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openTestDb } from "./test-db";
import { insertProject, getProject, listProjects } from "./projects";
import { mountProjectsRoutes } from "../server/handlers/projects";

let db: Database;
let app: Hono;

beforeEach(() => {
  db = openTestDb();
  app = new Hono();
  mountProjectsRoutes(app, { db });
});

afterEach(() => {
  db.close();
});

describe("projects query helpers", () => {
  test("insertProject returns the inserted row with generated created_at", () => {
    const project = insertProject(db, {
      id: "abc-123",
      name: "My Project",
      repo_path: "/home/user/myrepo",
    });

    expect(project.id).toBe("abc-123");
    expect(project.name).toBe("My Project");
    expect(project.repo_path).toBe("/home/user/myrepo");
    expect(typeof project.created_at).toBe("string");
    expect(project.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("getProject returns null for unknown id", () => {
    expect(getProject(db, "no-such-id")).toBeNull();
  });

  test("getProject returns the row after insert", () => {
    insertProject(db, { id: "p1", name: "Proj", repo_path: "/srv/proj" });
    const found = getProject(db, "p1");
    expect(found?.name).toBe("Proj");
  });

  test("listProjects returns all rows ordered by created_at", () => {
    insertProject(db, { id: "a", name: "A", repo_path: "/a" });
    insertProject(db, { id: "b", name: "B", repo_path: "/b" });
    const projects = listProjects(db);
    expect(projects).toHaveLength(2);
    expect(projects[0].id).toBe("a");
    expect(projects[1].id).toBe("b");
  });

  test("repo_path UNIQUE constraint throws on duplicate", () => {
    insertProject(db, { id: "x", name: "X", repo_path: "/shared" });
    expect(() => insertProject(db, { id: "y", name: "Y", repo_path: "/shared" })).toThrow();
  });
});

describe("GET /projects", () => {
  test("returns empty array when no projects", async () => {
    const res = await app.request("/projects");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("returns inserted projects", async () => {
    insertProject(db, { id: "p1", name: "One", repo_path: "/one" });
    const res = await app.request("/projects");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string }[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("p1");
  });
});

describe("POST /projects", () => {
  test("creates a project and returns 201", async () => {
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New Project", repo_path: "/home/user/new" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      name: string;
      repo_path: string;
      created_at: string;
    };
    expect(typeof body.id).toBe("string");
    expect(body.name).toBe("New Project");
    expect(body.repo_path).toBe("/home/user/new");
    expect(body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("returns 400 for empty name", async () => {
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "", repo_path: "/valid/path" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 for relative repo_path", async () => {
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "P", repo_path: "relative/path" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/absolute/);
  });

  test("returns 409 for duplicate repo_path", async () => {
    await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "First", repo_path: "/dup" }),
    });
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Second", repo_path: "/dup" }),
    });
    expect(res.status).toBe(409);
  });

  test("returns 400 for invalid json", async () => {
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /projects/:id", () => {
  test("returns 404 for unknown id", async () => {
    const res = await app.request("/projects/no-such-id");
    expect(res.status).toBe(404);
  });

  test("returns the project by id", async () => {
    insertProject(db, { id: "known", name: "Known", repo_path: "/known" });
    const res = await app.request("/projects/known");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string };
    expect(body.id).toBe("known");
    expect(body.name).toBe("Known");
  });
});
