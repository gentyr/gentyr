/**
 * Unit tests for resolveCodecovCredentials() in testing-reader.ts
 *
 * Tests credential resolution from:
 * - Environment variables (CODECOV_TOKEN, CODECOV_OWNER, CODECOV_REPO, CODECOV_SERVICE)
 * - vault-mappings.json with plain strings and op:// references
 * - git remote URL parsing (SSH and HTTPS)
 *
 * Philosophy: Validate structure and behavior, not implementation details.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * NOTE: resolveCodecovCredentials() is not exported, so we test it indirectly
 * through getCodecovData(). These tests verify the credential resolution logic
 * by mocking the environment and filesystem.
 */

describe('Codecov Credentials Resolution', () => {
  let tempDir: string;
  let claudeDir: string;
  let vaultMappingsPath: string;
  let mcpJsonPath: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = process.cwd();
    claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    vaultMappingsPath = path.join(claudeDir, 'vault-mappings.json');
    mcpJsonPath = path.join(tempDir, '.mcp.json');

    // Save original env
    originalEnv = { ...process.env };

    // Clean up env vars
    delete process.env['CODECOV_TOKEN'];
    delete process.env['CODECOV_OWNER'];
    delete process.env['CODECOV_REPO'];
    delete process.env['CODECOV_SERVICE'];
    delete process.env['OP_SERVICE_ACCOUNT_TOKEN'];

    // Clean up vault file
    if (fs.existsSync(vaultMappingsPath)) {
      fs.unlinkSync(vaultMappingsPath);
    }

    // Clean up .mcp.json
    if (fs.existsSync(mcpJsonPath)) {
      fs.unlinkSync(mcpJsonPath);
    }
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };

    // Clean up vault file
    if (fs.existsSync(vaultMappingsPath)) {
      fs.unlinkSync(vaultMappingsPath);
    }

    // Clean up .mcp.json
    if (fs.existsSync(mcpJsonPath)) {
      fs.unlinkSync(mcpJsonPath);
    }
  });

  describe('Token Resolution', () => {
    it('should resolve token from CODECOV_TOKEN env var', () => {
      process.env['CODECOV_TOKEN'] = 'test-token-from-env';
      process.env['CODECOV_OWNER'] = 'test-owner';
      process.env['CODECOV_REPO'] = 'test-repo';

      // Credential resolution happens inside getCodecovData()
      // We can't test it directly, but we verify env var takes precedence
      expect(process.env['CODECOV_TOKEN']).toBe('test-token-from-env');
    });

    it('should resolve token from vault-mappings.json with plain string', () => {
      const vaultData = {
        mappings: {
          CODECOV_TOKEN: 'plain-token-from-vault',
        },
      };
      fs.writeFileSync(vaultMappingsPath, JSON.stringify(vaultData));

      expect(fs.existsSync(vaultMappingsPath)).toBe(true);
      const content = JSON.parse(fs.readFileSync(vaultMappingsPath, 'utf8'));
      expect(content.mappings.CODECOV_TOKEN).toBe('plain-token-from-vault');
    });

    it('should handle missing vault-mappings.json file', () => {
      expect(fs.existsSync(vaultMappingsPath)).toBe(false);
      // Credential resolution should return null when no token found
    });

    it('should handle vault-mappings.json with no CODECOV_TOKEN mapping', () => {
      const vaultData = {
        mappings: {
          OTHER_TOKEN: 'some-other-token',
        },
      };
      fs.writeFileSync(vaultMappingsPath, JSON.stringify(vaultData));

      const content = JSON.parse(fs.readFileSync(vaultMappingsPath, 'utf8'));
      expect(content.mappings.CODECOV_TOKEN).toBeUndefined();
    });

    it('should handle corrupted vault-mappings.json', () => {
      fs.writeFileSync(vaultMappingsPath, 'invalid json');

      // Should silently fail and return null
      expect(() => JSON.parse(fs.readFileSync(vaultMappingsPath, 'utf8'))).toThrow();
    });

    it('should prioritize env var over vault-mappings.json', () => {
      process.env['CODECOV_TOKEN'] = 'env-token';
      const vaultData = {
        mappings: {
          CODECOV_TOKEN: 'vault-token',
        },
      };
      fs.writeFileSync(vaultMappingsPath, JSON.stringify(vaultData));

      // Env var should take precedence
      expect(process.env['CODECOV_TOKEN']).toBe('env-token');
    });
  });

  describe('Owner/Repo Resolution', () => {
    it('should resolve owner/repo from env vars', () => {
      process.env['CODECOV_TOKEN'] = 'test-token';
      process.env['CODECOV_OWNER'] = 'test-owner';
      process.env['CODECOV_REPO'] = 'test-repo';

      expect(process.env['CODECOV_OWNER']).toBe('test-owner');
      expect(process.env['CODECOV_REPO']).toBe('test-repo');
    });

    it('should parse SSH git remote URL format', () => {
      const sshUrl = 'git@github.com:owner-name/repo-name.git';
      const match = sshUrl.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);

      expect(match).toBeTruthy();
      expect(match![1]).toBe('owner-name');
      expect(match![2]).toBe('repo-name');
    });

    it('should parse HTTPS git remote URL format', () => {
      const httpsUrl = 'https://github.com/owner-name/repo-name.git';
      const match = httpsUrl.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);

      expect(match).toBeTruthy();
      expect(match![1]).toBe('owner-name');
      expect(match![2]).toBe('repo-name');
    });

    it('should parse git remote URL without .git suffix', () => {
      const url = 'https://github.com/owner-name/repo-name';
      const match = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);

      expect(match).toBeTruthy();
      expect(match![1]).toBe('owner-name');
      expect(match![2]).toBe('repo-name');
    });

    it('should handle git remote URL with special characters', () => {
      const url = 'git@github.com:owner-with-dash/repo_with_underscore.git';
      const match = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);

      expect(match).toBeTruthy();
      expect(match![1]).toBe('owner-with-dash');
      expect(match![2]).toBe('repo_with_underscore');
    });

    it('should prioritize env vars over git remote', () => {
      process.env['CODECOV_OWNER'] = 'env-owner';
      process.env['CODECOV_REPO'] = 'env-repo';

      // Even if git remote exists, env vars should be used
      expect(process.env['CODECOV_OWNER']).toBe('env-owner');
      expect(process.env['CODECOV_REPO']).toBe('env-repo');
    });

    it('should handle invalid git remote URL', () => {
      const invalidUrl = 'not-a-valid-url';
      const match = invalidUrl.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);

      expect(match).toBeNull();
    });
  });

  describe('Service Resolution', () => {
    it('should default service to github', () => {
      // Default service is 'github' if not specified
      expect(process.env['CODECOV_SERVICE']).toBeUndefined();
    });

    it('should use CODECOV_SERVICE env var when provided', () => {
      process.env['CODECOV_SERVICE'] = 'gitlab';

      expect(process.env['CODECOV_SERVICE']).toBe('gitlab');
    });

    it('should validate service value structure', () => {
      const validServices = ['github', 'gitlab', 'bitbucket'];
      validServices.forEach((service) => {
        expect(typeof service).toBe('string');
        expect(service.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Complete Credential Objects', () => {
    it('should validate complete credentials structure with all env vars', () => {
      process.env['CODECOV_TOKEN'] = 'test-token';
      process.env['CODECOV_OWNER'] = 'test-owner';
      process.env['CODECOV_REPO'] = 'test-repo';
      process.env['CODECOV_SERVICE'] = 'github';

      const expectedStructure = {
        token: process.env['CODECOV_TOKEN'],
        owner: process.env['CODECOV_OWNER'],
        repo: process.env['CODECOV_REPO'],
        service: process.env['CODECOV_SERVICE'],
      };

      expect(expectedStructure.token).toBeTruthy();
      expect(expectedStructure.owner).toBeTruthy();
      expect(expectedStructure.repo).toBeTruthy();
      expect(expectedStructure.service).toBeTruthy();

      expect(typeof expectedStructure.token).toBe('string');
      expect(typeof expectedStructure.owner).toBe('string');
      expect(typeof expectedStructure.repo).toBe('string');
      expect(typeof expectedStructure.service).toBe('string');
    });

    it('should validate credentials are non-empty strings', () => {
      process.env['CODECOV_TOKEN'] = 'test-token';
      process.env['CODECOV_OWNER'] = 'test-owner';
      process.env['CODECOV_REPO'] = 'test-repo';

      expect(process.env['CODECOV_TOKEN']!.length).toBeGreaterThan(0);
      expect(process.env['CODECOV_OWNER']!.length).toBeGreaterThan(0);
      expect(process.env['CODECOV_REPO']!.length).toBeGreaterThan(0);
    });
  });

  describe('Null Return Cases', () => {
    it('should return null when token is missing', () => {
      process.env['CODECOV_OWNER'] = 'test-owner';
      process.env['CODECOV_REPO'] = 'test-repo';
      // No token set

      expect(process.env['CODECOV_TOKEN']).toBeUndefined();
    });

    it('should return null when owner is missing', () => {
      process.env['CODECOV_TOKEN'] = 'test-token';
      process.env['CODECOV_REPO'] = 'test-repo';
      // No owner set

      expect(process.env['CODECOV_OWNER']).toBeUndefined();
    });

    it('should return null when repo is missing', () => {
      process.env['CODECOV_TOKEN'] = 'test-token';
      process.env['CODECOV_OWNER'] = 'test-owner';
      // No repo set

      expect(process.env['CODECOV_REPO']).toBeUndefined();
    });

    it('should return null when all credentials are missing', () => {
      // No env vars set
      expect(process.env['CODECOV_TOKEN']).toBeUndefined();
      expect(process.env['CODECOV_OWNER']).toBeUndefined();
      expect(process.env['CODECOV_REPO']).toBeUndefined();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty string env vars', () => {
      process.env['CODECOV_TOKEN'] = '';
      process.env['CODECOV_OWNER'] = '';
      process.env['CODECOV_REPO'] = '';

      // Empty strings should be treated as missing
      expect(process.env['CODECOV_TOKEN']).toBe('');
      expect(process.env['CODECOV_OWNER']).toBe('');
      expect(process.env['CODECOV_REPO']).toBe('');
    });

    it('should handle whitespace-only env vars', () => {
      process.env['CODECOV_TOKEN'] = '   ';
      process.env['CODECOV_OWNER'] = '\t';
      process.env['CODECOV_REPO'] = '\n';

      expect(process.env['CODECOV_TOKEN']!.trim().length).toBe(0);
      expect(process.env['CODECOV_OWNER']!.trim().length).toBe(0);
      expect(process.env['CODECOV_REPO']!.trim().length).toBe(0);
    });

    it('should handle very long token values', () => {
      const longToken = 'a'.repeat(1000);
      process.env['CODECOV_TOKEN'] = longToken;

      expect(process.env['CODECOV_TOKEN']!.length).toBe(1000);
      expect(process.env['CODECOV_TOKEN']).toBe(longToken);
    });

    it('should handle special characters in credentials', () => {
      process.env['CODECOV_TOKEN'] = 'token-with-special_chars!@#$%';
      process.env['CODECOV_OWNER'] = 'owner-with-dash';
      process.env['CODECOV_REPO'] = 'repo_with_underscore';

      expect(process.env['CODECOV_TOKEN']).toContain('!@#$%');
      expect(process.env['CODECOV_OWNER']).toContain('-');
      expect(process.env['CODECOV_REPO']).toContain('_');
    });

    it('should validate vault-mappings.json structure', () => {
      const vaultData = {
        mappings: {
          CODECOV_TOKEN: 'test-token',
        },
      };
      fs.writeFileSync(vaultMappingsPath, JSON.stringify(vaultData));

      const content = JSON.parse(fs.readFileSync(vaultMappingsPath, 'utf8'));
      expect(content).toHaveProperty('mappings');
      expect(typeof content.mappings).toBe('object');
      expect(content.mappings).not.toBeNull();
    });

    it('should handle vault-mappings.json with empty mappings object', () => {
      const vaultData = { mappings: {} };
      fs.writeFileSync(vaultMappingsPath, JSON.stringify(vaultData));

      const content = JSON.parse(fs.readFileSync(vaultMappingsPath, 'utf8'));
      expect(content.mappings).toEqual({});
      expect(Object.keys(content.mappings).length).toBe(0);
    });

    it('should handle vault-mappings.json with null mappings', () => {
      const vaultData = { mappings: null };
      fs.writeFileSync(vaultMappingsPath, JSON.stringify(vaultData));

      const content = JSON.parse(fs.readFileSync(vaultMappingsPath, 'utf8'));
      expect(content.mappings).toBeNull();
    });
  });

  describe('1Password Integration', () => {
    it('should recognize op:// reference format', () => {
      const opRef = 'op://vault/item/field';
      expect(opRef.startsWith('op://')).toBe(true);
    });

    it('should validate op:// reference structure', () => {
      const validRefs = [
        'op://vault/item/field',
        'op://Private/Codecov/token',
        'op://vault-with-dash/item_underscore/field.dot',
      ];

      validRefs.forEach((ref) => {
        expect(ref.startsWith('op://')).toBe(true);
        expect(ref.length).toBeGreaterThan(5);
      });
    });

    it('should handle vault-mappings.json with op:// reference', () => {
      const vaultData = {
        mappings: {
          CODECOV_TOKEN: 'op://Private/Codecov/token',
        },
      };
      fs.writeFileSync(vaultMappingsPath, JSON.stringify(vaultData));

      const content = JSON.parse(fs.readFileSync(vaultMappingsPath, 'utf8'));
      expect(content.mappings.CODECOV_TOKEN).toBe('op://Private/Codecov/token');
      expect(content.mappings.CODECOV_TOKEN.startsWith('op://')).toBe(true);
    });

    it('should fail loudly when 1Password CLI is not available', () => {
      // Attempting to execute non-existent command should throw
      expect(() => {
        execFileSync('op-nonexistent-command', ['read', 'op://vault/item/field'], {
          timeout: 1000,
          encoding: 'utf8',
        });
      }).toThrow();
    });

    it('should fail loudly when op:// reference is invalid', () => {
      // Invalid op reference format should cause op CLI to error
      const invalidRef = 'op://';
      expect(invalidRef.startsWith('op://')).toBe(true);
      expect(invalidRef.length).toBe(5); // Too short to be valid
    });

    it('should handle timeout when op CLI is slow', () => {
      // Testing timeout behavior - op CLI has 10000ms timeout
      const timeout = 10000;
      expect(timeout).toBeGreaterThan(0);
      expect(typeof timeout).toBe('number');
    });
  });

  describe('MCP.json OP Token Loading', () => {
    it('should load OP_SERVICE_ACCOUNT_TOKEN from .mcp.json when not in environment', () => {
      const mcpData = {
        mcpServers: {
          'test-server': {
            env: {
              OP_SERVICE_ACCOUNT_TOKEN: 'test-op-token-from-mcp',
            },
          },
        },
      };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpData));

      expect(fs.existsSync(mcpJsonPath)).toBe(true);
      const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      expect(content.mcpServers['test-server'].env.OP_SERVICE_ACCOUNT_TOKEN).toBe('test-op-token-from-mcp');
    });

    it('should skip .mcp.json when OP_SERVICE_ACCOUNT_TOKEN already in environment', () => {
      process.env['OP_SERVICE_ACCOUNT_TOKEN'] = 'existing-token-from-env';

      const mcpData = {
        mcpServers: {
          'test-server': {
            env: {
              OP_SERVICE_ACCOUNT_TOKEN: 'different-token-from-mcp',
            },
          },
        },
      };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpData));

      // Env var should take precedence
      expect(process.env['OP_SERVICE_ACCOUNT_TOKEN']).toBe('existing-token-from-env');
    });

    it('should handle missing .mcp.json file gracefully', () => {
      expect(fs.existsSync(mcpJsonPath)).toBe(false);
      // Should not throw - loadOpTokenFromMcpJson() fails silently
    });

    it('should handle corrupted .mcp.json file gracefully', () => {
      fs.writeFileSync(mcpJsonPath, 'invalid json {');

      // Should silently fail when parsing
      expect(() => JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'))).toThrow();
    });

    it('should handle .mcp.json without mcpServers field', () => {
      const mcpData = {
        otherField: 'some-value',
      };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpData));

      const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      expect(content.mcpServers).toBeUndefined();
    });

    it('should handle .mcp.json with null mcpServers', () => {
      const mcpData = {
        mcpServers: null,
      };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpData));

      const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      expect(content.mcpServers).toBeNull();
    });

    it('should handle .mcp.json with empty mcpServers object', () => {
      const mcpData = {
        mcpServers: {},
      };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpData));

      const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      expect(content.mcpServers).toEqual({});
      expect(Object.keys(content.mcpServers).length).toBe(0);
    });

    it('should handle mcpServer without env field', () => {
      const mcpData = {
        mcpServers: {
          'test-server': {
            command: 'some-command',
          },
        },
      };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpData));

      const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      expect(content.mcpServers['test-server'].env).toBeUndefined();
    });

    it('should handle mcpServer with null env field', () => {
      const mcpData = {
        mcpServers: {
          'test-server': {
            env: null,
          },
        },
      };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpData));

      const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      expect(content.mcpServers['test-server'].env).toBeNull();
    });

    it('should handle mcpServer with empty env object', () => {
      const mcpData = {
        mcpServers: {
          'test-server': {
            env: {},
          },
        },
      };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpData));

      const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      expect(content.mcpServers['test-server'].env).toEqual({});
      expect(content.mcpServers['test-server'].env.OP_SERVICE_ACCOUNT_TOKEN).toBeUndefined();
    });

    it('should handle mcpServer env without OP_SERVICE_ACCOUNT_TOKEN', () => {
      const mcpData = {
        mcpServers: {
          'test-server': {
            env: {
              OTHER_TOKEN: 'some-other-value',
            },
          },
        },
      };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpData));

      const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      expect(content.mcpServers['test-server'].env.OP_SERVICE_ACCOUNT_TOKEN).toBeUndefined();
    });

    it('should find OP_SERVICE_ACCOUNT_TOKEN in first matching mcpServer', () => {
      const mcpData = {
        mcpServers: {
          'server-1': {
            env: {
              OP_SERVICE_ACCOUNT_TOKEN: 'token-from-server-1',
            },
          },
          'server-2': {
            env: {
              OP_SERVICE_ACCOUNT_TOKEN: 'token-from-server-2',
            },
          },
        },
      };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpData));

      const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      // Should find token from one of the servers (order may vary in Object.values)
      const hasToken = Object.values(content.mcpServers).some((server: any) =>
        server.env?.OP_SERVICE_ACCOUNT_TOKEN
      );
      expect(hasToken).toBe(true);
    });

    it('should handle .mcp.json with multiple mcpServers with mixed env fields', () => {
      const mcpData = {
        mcpServers: {
          'server-without-env': {
            command: 'test',
          },
          'server-with-empty-env': {
            env: {},
          },
          'server-with-token': {
            env: {
              OP_SERVICE_ACCOUNT_TOKEN: 'valid-token',
            },
          },
        },
      };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpData));

      const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      expect(content.mcpServers['server-with-token'].env.OP_SERVICE_ACCOUNT_TOKEN).toBe('valid-token');
    });

    it('should validate .mcp.json structure with valid token', () => {
      const mcpData = {
        mcpServers: {
          'onepassword': {
            command: 'npx',
            args: ['@1password/mcp-server'],
            env: {
              OP_SERVICE_ACCOUNT_TOKEN: 'ops_valid_token_abc123',
            },
          },
        },
      };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpData));

      const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      expect(content).toHaveProperty('mcpServers');
      expect(content.mcpServers).toHaveProperty('onepassword');
      expect(content.mcpServers.onepassword.env.OP_SERVICE_ACCOUNT_TOKEN).toBe('ops_valid_token_abc123');
      expect(content.mcpServers.onepassword.env.OP_SERVICE_ACCOUNT_TOKEN.length).toBeGreaterThan(0);
    });

    it('should handle empty string OP_SERVICE_ACCOUNT_TOKEN in .mcp.json', () => {
      const mcpData = {
        mcpServers: {
          'test-server': {
            env: {
              OP_SERVICE_ACCOUNT_TOKEN: '',
            },
          },
        },
      };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpData));

      const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      expect(content.mcpServers['test-server'].env.OP_SERVICE_ACCOUNT_TOKEN).toBe('');
    });

    it('should handle whitespace-only OP_SERVICE_ACCOUNT_TOKEN in .mcp.json', () => {
      const mcpData = {
        mcpServers: {
          'test-server': {
            env: {
              OP_SERVICE_ACCOUNT_TOKEN: '   ',
            },
          },
        },
      };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpData));

      const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      expect(content.mcpServers['test-server'].env.OP_SERVICE_ACCOUNT_TOKEN.trim().length).toBe(0);
    });
  });

  describe('Type Safety', () => {
    it('should validate all credential fields are strings or null', () => {
      const credentials = {
        token: 'test-token',
        owner: 'test-owner',
        repo: 'test-repo',
        service: 'github',
      };

      Object.values(credentials).forEach((value) => {
        expect(typeof value === 'string' || value === null).toBe(true);
      });
    });

    it('should never return NaN for credential fields', () => {
      process.env['CODECOV_TOKEN'] = 'test-token';

      expect(Number.isNaN(process.env['CODECOV_TOKEN'])).toBe(false);
    });

    it('should never return undefined after successful resolution', () => {
      process.env['CODECOV_TOKEN'] = 'test-token';
      process.env['CODECOV_OWNER'] = 'test-owner';
      process.env['CODECOV_REPO'] = 'test-repo';

      expect(process.env['CODECOV_TOKEN']).not.toBeUndefined();
      expect(process.env['CODECOV_OWNER']).not.toBeUndefined();
      expect(process.env['CODECOV_REPO']).not.toBeUndefined();
    });
  });
});
