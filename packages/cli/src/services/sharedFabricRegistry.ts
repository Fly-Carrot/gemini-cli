/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSkillFromFile,
  type SkillDefinition,
} from '@google/gemini-cli-core';

function getDefaultSharedFabricRoot(): string {
  return path.join(os.homedir(), 'Antigravity_Skills', 'global-agent-fabric');
}

function getDefaultSkillsIndexPath(globalRoot: string): string {
  return path.join(
    path.dirname(globalRoot),
    'awesome-skills',
    'skills_index.json',
  );
}

function getDefaultDomainMapPath(): string {
  return path.join(
    os.homedir(),
    '.gemini',
    'antigravity',
    'global_workflows',
    'skills-domain-map.md',
  );
}

interface SharedFabricSkillSource {
  id: string;
  type: string;
  path: string;
  skillCount: number;
}

interface SharedFabricSkillCatalogEntry {
  id: string;
  path: string;
  category?: string;
  name: string;
  description?: string;
  risk?: string;
  source?: string;
  dateAdded?: string;
}

export interface SharedFabricSkillCandidate extends SkillDefinition {
  category?: string;
  risk?: string;
  sourceId?: string;
  sourceType?: string;
  catalogSource?: string;
  score?: number;
  trustedRoot?: string;
}

interface SharedFabricDomainRoute {
  label: string;
  summary: string;
  keywords: string[];
  representativeSkills: string[];
}

export interface SharedFabricRouteResult {
  domain?: SharedFabricDomainRoute;
  skills: SharedFabricSkillCandidate[];
}

export interface SharedFabricStatus {
  available: boolean;
  globalRoot: string;
  workspaceRoot: string;
  bootSequencePath: string;
  runtimeMapPath: string;
  memoryRoutesPath: string;
  domainMapPath: string;
  skillsIndexPath: string;
  workspaceOverlayPath: string;
  bootSequenceExists: boolean;
  runtimeMapExists: boolean;
  memoryRoutesExists: boolean;
  domainMapExists: boolean;
  skillsIndexExists: boolean;
  workspaceOverlayExists: boolean;
  sources: SharedFabricSkillSource[];
  indexedSkillCount: number;
  routedDomainCount: number;
}

interface SharedFabricRegistryOptions {
  globalRoot?: string;
  workspaceRoot?: string;
  skillsIndexPath?: string;
  domainMapPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readStringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function extractCatalogEntries(
  parsed: unknown,
): Array<Record<string, unknown>> {
  if (Array.isArray(parsed)) {
    return parsed.filter(isRecord);
  }
  if (!isRecord(parsed)) {
    return [];
  }
  const skills = parsed['skills'];
  return Array.isArray(skills) ? skills.filter(isRecord) : [];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/[^a-z0-9\u4e00-\u9fff-]+/i)
    .filter(Boolean);
}

function uniqueByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];

  for (const item of items) {
    const key = normalize(item.name);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
  }

  return unique;
}

function isWithinTrustedRoot(
  candidatePath: string,
  trustedRoot: string,
): boolean {
  const relative = path.relative(trustedRoot, candidatePath);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function defined<T>(value: T | null): value is T {
  return value !== null;
}

export class SharedFabricRegistry {
  readonly globalRoot: string;
  readonly workspaceRoot: string;
  readonly bootSequencePath: string;
  readonly runtimeMapPath: string;
  readonly memoryRoutesPath: string;
  readonly domainMapPath: string;
  readonly skillsIndexPath: string;
  readonly workspaceOverlayPath: string;

  private sourcesCache?: SharedFabricSkillSource[];
  private catalogCache?: SharedFabricSkillCatalogEntry[];
  private domainRoutesCache?: SharedFabricDomainRoute[];

  constructor(options: SharedFabricRegistryOptions = {}) {
    this.globalRoot =
      options.globalRoot ||
      process.env['GEMINI2_SHARED_FABRIC_ROOT'] ||
      process.env['AGF_GLOBAL_ROOT'] ||
      getDefaultSharedFabricRoot();
    this.workspaceRoot =
      options.workspaceRoot ||
      process.env['GEMINI2_SHARED_FABRIC_WORKSPACE'] ||
      process.env['AGF_WORKSPACE'] ||
      process.cwd();
    this.bootSequencePath = path.join(
      this.globalRoot,
      'sync',
      'boot-sequence.md',
    );
    this.runtimeMapPath = path.join(
      this.globalRoot,
      'sync',
      'runtime-map.yaml',
    );
    this.memoryRoutesPath = path.join(this.globalRoot, 'memory', 'routes.yaml');
    this.domainMapPath =
      options.domainMapPath ||
      process.env['GEMINI2_SHARED_FABRIC_DOMAIN_MAP'] ||
      process.env['AGF_DOMAIN_MAP_PATH'] ||
      getDefaultDomainMapPath();
    this.skillsIndexPath =
      options.skillsIndexPath ||
      process.env['GEMINI2_SHARED_FABRIC_SKILLS_INDEX'] ||
      process.env['AGF_SKILLS_INDEX_PATH'] ||
      getDefaultSkillsIndexPath(this.globalRoot);
    this.workspaceOverlayPath = path.join(
      this.workspaceRoot,
      '.agents',
      'sync',
      'user-question-profile.md',
    );
  }

  async getStatus(): Promise<SharedFabricStatus> {
    const [
      bootSequenceExists,
      runtimeMapExists,
      memoryRoutesExists,
      domainMapExists,
      skillsIndexExists,
      workspaceOverlayExists,
      sources,
      catalog,
      domainRoutes,
    ] = await Promise.all([
      this.pathExists(this.bootSequencePath),
      this.pathExists(this.runtimeMapPath),
      this.pathExists(this.memoryRoutesPath),
      this.pathExists(this.domainMapPath),
      this.pathExists(this.skillsIndexPath),
      this.pathExists(this.workspaceOverlayPath),
      this.loadSources(),
      this.loadCatalog(),
      this.loadDomainRoutes(),
    ]);

    return {
      available: bootSequenceExists && runtimeMapExists,
      globalRoot: this.globalRoot,
      workspaceRoot: this.workspaceRoot,
      bootSequencePath: this.bootSequencePath,
      runtimeMapPath: this.runtimeMapPath,
      memoryRoutesPath: this.memoryRoutesPath,
      domainMapPath: this.domainMapPath,
      skillsIndexPath: this.skillsIndexPath,
      workspaceOverlayPath: this.workspaceOverlayPath,
      bootSequenceExists,
      runtimeMapExists,
      memoryRoutesExists,
      domainMapExists,
      skillsIndexExists,
      workspaceOverlayExists,
      sources,
      indexedSkillCount: catalog.length,
      routedDomainCount: domainRoutes.length,
    };
  }

  async searchSkills(
    query: string,
    limit: number = 12,
  ): Promise<SharedFabricSkillCandidate[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const [catalog, domainRoutes] = await Promise.all([
      this.loadCatalog(),
      this.loadDomainRoutes(),
    ]);
    const queryTokens = tokenize(normalizedQuery);
    const matchedDomain = this.matchDomain(normalizedQuery, domainRoutes);

    const scored = catalog
      .map((entry) => {
        let score = 0;
        const name = normalize(entry.name);
        const description = normalize(entry.description || '');
        const category = normalize(entry.category || '');

        if (
          name === normalize(normalizedQuery) ||
          entry.id === normalizedQuery
        ) {
          score += 10;
        }

        for (const token of queryTokens) {
          if (name.includes(token)) {
            score += 4;
          }
          if (description.includes(token)) {
            score += 2;
          }
          if (category.includes(token)) {
            score += 1;
          }
        }

        if (
          matchedDomain &&
          matchedDomain.representativeSkills.some(
            (skillName) => normalize(skillName) === name,
          )
        ) {
          score += 5;
        }

        return {
          entry,
          score,
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.entry.name.localeCompare(right.entry.name);
      })
      .slice(0, limit);

    if (scored.length > 0) {
      const candidates = await Promise.all(
        scored.map((candidate) =>
          this.toSkillCandidate(candidate.entry, candidate.score),
        ),
      );
      return candidates.filter(defined);
    }

    if (!matchedDomain) {
      return [];
    }

    return this.loadRepresentativeSkills(matchedDomain, limit);
  }

  async recommendSkills(
    query: string,
    limit: number = 8,
  ): Promise<SharedFabricRouteResult> {
    const domainRoutes = await this.loadDomainRoutes();
    const matchedDomain = this.matchDomain(query, domainRoutes);
    const searchResults = await this.searchSkills(query, limit * 2);
    const prioritized = matchedDomain
      ? await this.prioritizeForDomain(matchedDomain, searchResults, limit)
      : searchResults.slice(0, limit);

    return {
      domain: matchedDomain,
      skills: prioritized,
    };
  }

  async findSkillByName(
    name: string,
  ): Promise<SharedFabricSkillCandidate | null> {
    const catalog = await this.loadCatalog();
    const normalizedName = normalize(name);
    const matched = catalog.find(
      (entry) =>
        normalize(entry.name) === normalizedName ||
        normalize(entry.id) === normalizedName,
    );

    if (!matched) {
      return null;
    }

    return this.toSkillCandidate(matched, 10);
  }

  async loadSkillDefinition(name: string): Promise<SkillDefinition | null> {
    const candidate = await this.findSkillByName(name);
    if (!candidate) {
      return null;
    }

    if (
      !(await this.isTrustedSkillLocation(
        candidate.location,
        candidate.trustedRoot,
      ))
    ) {
      return null;
    }

    return loadSkillFromFile(candidate.location);
  }

  async completeSkillNames(
    partial: string,
    limit: number = 20,
  ): Promise<string[]> {
    const catalog = await this.loadCatalog();
    const normalizedPartial = normalize(partial);

    return catalog
      .filter((entry) => normalize(entry.name).startsWith(normalizedPartial))
      .map((entry) => entry.name)
      .slice(0, limit);
  }

  private async prioritizeForDomain(
    domain: SharedFabricDomainRoute,
    searchResults: SharedFabricSkillCandidate[],
    limit: number,
  ): Promise<SharedFabricSkillCandidate[]> {
    const catalog = await this.loadCatalog();
    const representative = uniqueByName(
      (
        await Promise.all(
          domain.representativeSkills
            .map((name) =>
              catalog.find(
                (entry) => normalize(entry.name) === normalize(name),
              ),
            )
            .filter((entry): entry is SharedFabricSkillCatalogEntry => !!entry)
            .slice(0, limit)
            .map((entry) => this.toSkillCandidate(entry, 8)),
        )
      ).filter(defined),
    );

    return uniqueByName([...representative, ...searchResults]).slice(0, limit);
  }

  private async loadRepresentativeSkills(
    domain: SharedFabricDomainRoute,
    limit: number,
  ): Promise<SharedFabricSkillCandidate[]> {
    const catalog = await this.loadCatalog();
    const representative = (
      await Promise.all(
        domain.representativeSkills
          .map((name) =>
            catalog.find((entry) => normalize(entry.name) === normalize(name)),
          )
          .filter((entry): entry is SharedFabricSkillCatalogEntry => !!entry)
          .slice(0, limit)
          .map((entry) => this.toSkillCandidate(entry, 6)),
      )
    ).filter(defined);

    return representative;
  }

  private matchDomain(
    query: string,
    domainRoutes: SharedFabricDomainRoute[],
  ): SharedFabricDomainRoute | undefined {
    const normalizedQuery = normalize(query);

    const ranked = domainRoutes
      .map((domain) => {
        let score = 0;
        if (normalizedQuery.includes(normalize(domain.label))) {
          score += 4;
        }
        if (normalizedQuery.includes(normalize(domain.summary))) {
          score += 3;
        }
        for (const keyword of domain.keywords) {
          if (normalizedQuery.includes(normalize(keyword))) {
            score += 2;
          }
        }
        for (const skillName of domain.representativeSkills) {
          if (normalizedQuery.includes(normalize(skillName))) {
            score += 3;
          }
        }
        return { domain, score };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);

    return ranked[0]?.domain;
  }

  private async toSkillCandidate(
    entry: SharedFabricSkillCatalogEntry,
    score: number,
  ): Promise<SharedFabricSkillCandidate | null> {
    const sources = await this.loadSources();
    const source =
      sources.find(
        (candidate) =>
          normalize(candidate.id) === normalize(entry.source || '') &&
          candidate.type.includes('skill'),
      ) || sources.find((candidate) => candidate.id === 'awesome-skills');

    const resolved = this.resolveSkillLocation(entry.path, source?.path);
    if (!resolved) {
      return null;
    }

    return {
      name: entry.name,
      description: entry.description || '',
      location: resolved.location,
      body: '',
      category: entry.category,
      risk: entry.risk,
      sourceId: source?.id,
      sourceType: source?.type,
      catalogSource: entry.source,
      score,
      trustedRoot: resolved.trustedRoot,
    };
  }

  private resolveSkillLocation(
    indexedPath: string,
    sourcePath: string | undefined,
  ): { location: string; trustedRoot: string } | null {
    if (!sourcePath) {
      const trustedRoot = path.resolve(path.dirname(this.skillsIndexPath));
      const location = path.resolve(trustedRoot, indexedPath, 'SKILL.md');
      return isWithinTrustedRoot(location, trustedRoot)
        ? { location, trustedRoot }
        : null;
    }

    const trustedRoot = path.resolve(
      path.basename(sourcePath) === 'skills'
        ? path.dirname(sourcePath)
        : sourcePath,
    );
    const location = path.resolve(trustedRoot, indexedPath, 'SKILL.md');
    return isWithinTrustedRoot(location, trustedRoot)
      ? { location, trustedRoot }
      : null;
  }

  private async isTrustedSkillLocation(
    location: string,
    trustedRoot: string | undefined,
  ): Promise<boolean> {
    const lexicalRoot = path.resolve(
      trustedRoot || path.dirname(this.skillsIndexPath),
    );
    const lexicalLocation = path.resolve(location);
    if (!isWithinTrustedRoot(lexicalLocation, lexicalRoot)) {
      return false;
    }

    try {
      const [realRoot, realLocation] = await Promise.all([
        fs.realpath(lexicalRoot),
        fs.realpath(lexicalLocation),
      ]);
      return isWithinTrustedRoot(realLocation, realRoot);
    } catch {
      return false;
    }
  }

  private async loadSources(): Promise<SharedFabricSkillSource[]> {
    if (this.sourcesCache) {
      return this.sourcesCache;
    }

    const sourcesPath = path.join(this.globalRoot, 'skills', 'sources.yaml');
    const content = await fs.readFile(sourcesPath, 'utf-8').catch(() => '');
    const lines = content.split(/\r?\n/);
    const sources: SharedFabricSkillSource[] = [];
    let current: Partial<SharedFabricSkillSource> | null = null;

    const flush = () => {
      if (!current?.id || !current.path || !current.type) {
        return;
      }
      sources.push({
        id: current.id,
        type: current.type,
        path: current.path,
        skillCount: Number(current.skillCount || 0),
      });
    };

    for (const line of lines) {
      if (line.trim() === '-' || line.startsWith('  -')) {
        flush();
        current = {};
        continue;
      }

      const match = line.match(/^\s*([a-zA-Z_]+):\s*(.+?)\s*$/);
      if (!match || !current) {
        continue;
      }

      const [, key, rawValue] = match;
      const value = rawValue.replace(/^['"]|['"]$/g, '');

      if (key === 'id') {
        current.id = value;
      } else if (key === 'type') {
        current.type = value;
      } else if (key === 'path') {
        current.path = value;
      } else if (key === 'skill_count') {
        current.skillCount = Number(value);
      }
    }

    flush();
    this.sourcesCache = sources;
    return sources;
  }

  private async loadCatalog(): Promise<SharedFabricSkillCatalogEntry[]> {
    if (this.catalogCache) {
      return this.catalogCache;
    }

    const raw = await fs
      .readFile(this.skillsIndexPath, 'utf-8')
      .catch(() => '');
    if (!raw) {
      this.catalogCache = [];
      return this.catalogCache;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      this.catalogCache = [];
      return this.catalogCache;
    }
    const entries = extractCatalogEntries(parsed);

    this.catalogCache = entries
      .map((entry) => ({
        id: String(entry['id'] || entry['name'] || ''),
        path: String(entry['path'] || ''),
        category: readStringField(entry, 'category'),
        name: String(entry['name'] || ''),
        description: readStringField(entry, 'description'),
        risk: readStringField(entry, 'risk'),
        source: readStringField(entry, 'source'),
        dateAdded: readStringField(entry, 'date_added'),
      }))
      .filter((entry) => entry.name && entry.path);

    return this.catalogCache;
  }

  private async loadDomainRoutes(): Promise<SharedFabricDomainRoute[]> {
    if (this.domainRoutesCache) {
      return this.domainRoutesCache;
    }

    const content = await fs
      .readFile(this.domainMapPath, 'utf-8')
      .catch(() => '');
    if (!content) {
      this.domainRoutesCache = [];
      return this.domainRoutesCache;
    }
    const sections = content.split(/^##\s+/m).slice(1);

    this.domainRoutesCache = sections
      .map((section) => {
        const lines = section.split(/\r?\n/).filter(Boolean);
        const label = lines[0]?.trim();
        if (!label) {
          return null;
        }

        const summary =
          lines.find((line) => !line.startsWith('**'))?.trim() || '';
        const keywordLine =
          lines.find((line) => line.startsWith('**高频关键词**')) || '';
        const keywords = keywordLine
          .replace('**高频关键词**：', '')
          .split(',')
          .map((keyword) => keyword.trim())
          .filter(Boolean);
        const representativeLine =
          lines.find((line) => line.startsWith('**代表 Skills**')) || '';
        const representativeSkills = [
          ...representativeLine.matchAll(/`([^`]+)`/g),
        ].map((match) => match[1].trim());

        return {
          label,
          summary,
          keywords,
          representativeSkills,
        };
      })
      .filter((section): section is SharedFabricDomainRoute => !!section);

    return this.domainRoutesCache;
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}
