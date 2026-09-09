import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBuiltin } from 'node:module';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function importSpecifiers(source, filename) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const imports = [];
  const createRequireNames = new Set(), requireNames = new Set(['require']);
  // Track Node's supported contextual loader without allowing computed dependency names.
  for (const node of ast.statements) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === 'node:module') {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
        if ((item.propertyName?.text ?? item.name.text) === 'createRequire') createRequireNames.add(item.name.text);
      }
    }
  }
  function findLoaders(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression) && createRequireNames.has(node.initializer.expression.text)) requireNames.add(node.name.text);
    ts.forEachChild(node, findLoaders);
  }
  findLoaders(ast);
  const add = expression => {
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
      && ts.isIdentifier(expression.expression.expression) && requireNames.has(expression.expression.expression.text)
      && expression.expression.name.text === 'resolve') expression = expression.arguments[0];
    imports.push(expression && ts.isStringLiteralLike(expression) ? expression.text : null);
  };
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) add(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && requireNames.has(node.expression.text)))) {
      if (node.arguments[0]) add(node.arguments[0]); else imports.push(null);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return imports;
}

export function importViolation(owner, sourceFile, specifier, packages) {
  if (specifier === null) return 'non-literal module loading cannot be checked';
  if (specifier.startsWith('.')) {
    const target = relative(owner.directory, resolve(dirname(sourceFile), specifier));
    return target === '..' || target.startsWith(`..${sep}`) ? 'relative import leaves its package' : undefined;
  }
  if (specifier.startsWith('/') || specifier.includes(':') && !specifier.startsWith('node:')) return 'absolute or URL module import';
  if (isBuiltin(specifier)) return ['@agentflow/domain', '@agentflow/engine'].includes(owner.name) ? 'environment dependency in portable package' : undefined;
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  if (name === owner.name) return 'use relative imports inside the same package';
  if (!Object.hasOwn(owner.dependencies, name)) return 'undeclared package dependency';
  const dependency = packages.find(item => item.name === name);
  if (dependency) {
    if (specifier !== name) return 'internal package subpath is not public';
    if (dependency.app) return 'application imported as a library';
    const allowed = {
      '@agentflow/domain': [],
      '@agentflow/engine': ['@agentflow/domain'],
      '@agentflow/integrations': ['@agentflow/domain', '@agentflow/engine'],
    }[owner.name];
    if (allowed && !allowed.includes(name)) return 'reverse package dependency';
  } else if (owner.name === '@agentflow/domain'
    || owner.name === '@agentflow/engine' && !['ajv', 'ajv-formats'].includes(name)) {
    return 'external dependency needs an explicit portability decision';
  }
  return undefined;
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'dist'].includes(entry.name)) return [];
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

export function checkBoundaries(workspaceRoot = root) {
  const packages = ['apps', 'packages'].flatMap(group => readdirSync(resolve(workspaceRoot, 'src', group), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => {
      const directory = resolve(workspaceRoot, 'src', group, entry.name);
      const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
      return { name: manifest.name, directory, app: group === 'apps', dependencies: { ...manifest.peerDependencies, ...manifest.dependencies } };
    }));
  const errors = [];
  for (const owner of packages) {
    for (const filename of sourceFiles(owner.directory)) {
      // Tests legitimately use Node's assertion/test API; production sources never inherit test globals.
      if (/\.test\./.test(filename)) continue;
      for (const specifier of importSpecifiers(readFileSync(filename, 'utf8'), filename)) {
        const error = importViolation(owner, filename, specifier, packages);
        if (error) errors.push(`${relative(workspaceRoot, filename)}: ${specifier ?? '<dynamic>'}: ${error}`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && existsSync(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkBoundaries();
  if (errors.length) { process.stderr.write(errors.join('\n') + '\n'); process.exitCode = 1; }
  else process.stdout.write('Package boundaries checked.\n');
}
