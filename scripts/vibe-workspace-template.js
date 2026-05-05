#!/usr/bin/env node
/**
 * vibe init --template — initialize workspace with pre-configured .vibe/ settings
 *
 * Usage:
 *   node scripts/vibe-workspace-template.js --template fastapi
 *   node scripts/vibe-workspace-template.js --template django
 *   node scripts/vibe-workspace-template.js --template nextjs
 *   node scripts/vibe-workspace-template.js --template rust-cli
 *   node scripts/vibe-workspace-template.js --template soc2
 *   node scripts/vibe-workspace-template.js --list
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const TEMPLATE = args.find(a => a.startsWith('--template='))?.split('=')[1]
	|| (args.includes('--template') ? args[args.indexOf('--template') + 1] : null);
const WORKSPACE = args.find(a => a.startsWith('--workspace='))?.split('=')[1]
	|| (args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] : null)
	|| process.cwd();
const LIST = args.includes('--list');

const VIBE_VERSION = '1.0.0';

const TEMPLATES = {
	'fastapi': {
		description: 'FastAPI Python backend',
		constraints: {
			rules: [
				{ type: 'deny_write', pattern: 'alembic/versions/**', message: 'DB migrations need manual review' },
				{ type: 'deny_write', pattern: '.env', message: 'Never modify .env directly' },
			]
		},
		rules: `# FastAPI Project Rules

## Code Style
- Use async/await for all endpoint handlers
- Type hints required for all function parameters and return values
- Pydantic models for request/response validation
- Use dependency injection for database sessions

## API Design
- RESTful resource naming (plural nouns, no verbs)
- Version prefix: /api/v1/
- Return consistent error format: {detail: string, code: string}

## Database
- Never write raw SQL — use SQLAlchemy ORM
- All schema changes via Alembic migrations
- Migration files need human review before applying
`,
		ignore: `# Python artifacts
__pycache__/
*.pyc
*.pyo
.venv/
venv/
.pytest_cache/
.mypy_cache/
# Secrets
.env
.env.*
secrets/
`
	},

	'django': {
		description: 'Django Python web framework',
		constraints: {
			rules: [
				{ type: 'deny_write', pattern: '**/migrations/**', message: 'Django migrations need manual review' },
				{ type: 'deny_write', pattern: 'settings.py', message: 'Django settings need careful review' },
			]
		},
		rules: `# Django Project Rules

## Models
- Never delete fields from models without a migration plan
- Use select_related/prefetch_related to avoid N+1 queries
- All querysets should be filtered (never pass unfiltered to templates)

## Security
- Use Django's built-in CSRF protection
- Never use eval() or exec() with user input
- Use parameterized queries — never string format SQL

## Migrations
- Always review auto-generated migrations before applying
- Never squash migrations in production without testing
`,
		ignore: `__pycache__/\n*.pyc\n.venv/\nvenv/\n.env\n*.log\nstatic_root/\nmedia_root/\n`
	},

	'nextjs': {
		description: 'Next.js React framework',
		constraints: {
			rules: [
				{ type: 'deny_write', pattern: 'next.config.*', message: 'Next.js config affects build — review carefully' },
				{ type: 'deny_write', pattern: '.env.local', message: 'Never modify .env.local directly' },
			]
		},
		rules: `# Next.js Project Rules

## Components
- Use Server Components by default — add 'use client' only when needed
- No direct DOM manipulation in Server Components
- Use Next.js Image component for images (next/image)

## Data Fetching
- Use server-side data fetching where possible
- React Query for client-side state management
- Never expose sensitive API keys in client components

## Routing
- Use App Router conventions (app/ directory)
- Loading states with loading.tsx
- Error boundaries with error.tsx
`,
		ignore: `.next/\nout/\nnode_modules/\n.env.local\n.env*.local\n`
	},

	'rust-cli': {
		description: 'Rust CLI application',
		constraints: {
			rules: [
				{ type: 'deny_write', pattern: 'Cargo.lock', message: 'Cargo.lock should be committed — review changes carefully' },
			]
		},
		rules: `# Rust CLI Project Rules

## Error Handling
- Use thiserror for library errors, anyhow for application errors
- Never use unwrap() in production code — use ? operator
- Meaningful error messages with context

## Performance
- Use iterators over loops where idiomatic
- Avoid unnecessary allocations in hot paths
- Profile before optimizing

## CLI Design
- Use clap for argument parsing
- Consistent exit codes (0 = success, 1 = user error, 2 = system error)
- Write to stderr for errors, stdout for output
`,
		ignore: `target/\n*.pdb\n`
	},

	'soc2': {
		description: 'SOC2 compliance constraints',
		constraints: {
			rules: [
				{ type: 'deny_write', pattern: '**/auth/**', message: 'Auth code changes require security review' },
				{ type: 'deny_write', pattern: '**/crypto/**', message: 'Crypto code changes require security review' },
				{ type: 'deny_write', pattern: '**/*migration*', message: 'Database migrations require DBA approval' },
				{ type: 'deny_write', pattern: '**/config/prod*', message: 'Production config requires change management' },
				{ type: 'deny_write', pattern: '.env.production', message: 'Production secrets require change management' },
			]
		},
		rules: `# SOC2 Compliance Rules

## Access Control
- All authentication changes require peer review
- MFA must not be disabled or bypassed
- No hard-coded credentials — use secrets manager

## Audit Trail
- All admin actions must be logged
- Log format: ISO timestamp, actor, action, resource, outcome
- Never delete or modify audit logs

## Data Protection
- PII must be encrypted at rest and in transit
- No PII in logs
- Data retention: follow defined policy per data classification

## Change Management
- Production changes require approved ticket
- No hotfixes without post-incident review
- Deployment scripts must be reviewed
`,
		ignore: `.env.production\nsecrets/\n*.pem\n*.key\n`
	},
};

if (LIST) {
	console.log('\n📋 Available workspace templates:\n');
	Object.entries(TEMPLATES).forEach(([name, t]) => {
		console.log(`  ${name.padEnd(12)} — ${t.description}`);
	});
	process.exit(0);
}

if (!TEMPLATE) {
	console.log('Usage: node vibe-workspace-template.js --template <name> [--workspace /path]');
	console.log('       node vibe-workspace-template.js --list');
	process.exit(0);
}

const template = TEMPLATES[TEMPLATE];
if (!template) {
	console.error(`Unknown template: ${TEMPLATE}. Run --list to see available templates.`);
	process.exit(1);
}

const vibePath = path.join(WORKSPACE, '.vibe');
fs.mkdirSync(vibePath, { recursive: true });

function writeIfMissing(filePath, content) {
	if (fs.existsSync(filePath)) {
		console.log(`⚠️  ${path.relative(WORKSPACE, filePath)} already exists — skipping`);
		return;
	}
	fs.writeFileSync(filePath, content);
	console.log(`✅ Created ${path.relative(WORKSPACE, filePath)}`);
}

console.log(`\n📦 Initializing workspace with template: ${TEMPLATE}\n`);

// Write constraints.json
const constraints = { vibeVersion: VIBE_VERSION, ...template.constraints };
writeIfMissing(path.join(vibePath, 'constraints.json'), JSON.stringify(constraints, null, '\t') + '\n');

// Write rules.md
writeIfMissing(path.join(vibePath, 'rules.md'), `<!-- vibeVersion: ${VIBE_VERSION} -->\n${template.rules}`);

// Write ignore
writeIfMissing(path.join(vibePath, 'ignore'), template.ignore);

console.log(`\n✅ Template "${TEMPLATE}" applied. Review .vibe/constraints.json and .vibe/rules.md.`);
