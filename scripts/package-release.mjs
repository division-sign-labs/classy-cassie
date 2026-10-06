// scripts/package-release.mjs
// Assemble one public package from the built, private workspace modules.

import { cpSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RELEASE_PACKAGE = "@quotient-forecasting/cassie";

function copyPackageFiles(pkg, destination) {
  mkdirSync(destination, { recursive: true });
  for (const path of pkg.manifest.files ?? []) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(path) || path === "." || path === "..") {
      throw new Error(`unsupported package file: ${pkg.name}/${path}`);
    }
    cpSync(join(pkg.path, path), join(destination, path), {
      recursive: true,
      filter(source) {
        const stat = lstatSync(source);
        if (!stat.isFile() && !stat.isDirectory()) throw new Error(`package file must not be a symlink: ${source}`);
        return true;
      },
    });
  }
}

function writeManifest(directory, manifest) {
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Bundle only workspace code. npm still installs platform-specific third-party dependencies. */
export function stageReleasePackage(packages, directory) {
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]));
  const cli = byName.get(RELEASE_PACKAGE);
  if (!cli) throw new Error(`release set does not contain ${RELEASE_PACKAGE}`);
  const included = new Map();
  function include(pkg) {
    if (included.has(pkg.name)) return;
    included.set(pkg.name, pkg);
    for (const [name, spec] of Object.entries({ ...pkg.manifest.dependencies, ...pkg.manifest.optionalDependencies })) {
      const dependency = byName.get(name);
      if (dependency) include(dependency);
      else if (spec.startsWith("workspace:")) throw new Error(`missing workspace dependency ${name}`);
    }
  }
  include(cli);

  const dependencies = {};
  const optionalDependencies = {};
  for (const pkg of included.values()) {
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const [name, spec] of Object.entries(pkg.manifest[field] ?? {})) {
        if (included.has(name)) continue;
        const previous = dependencies[name] ?? optionalDependencies[name];
        if (previous && previous !== spec) throw new Error(`conflicting dependency ${name}: ${previous} and ${spec}`);
        if (field === "dependencies") {
          dependencies[name] = spec;
          delete optionalDependencies[name];
        } else if (!dependencies[name]) optionalDependencies[name] = spec;
      }
    }
  }

  const bundled = [...included.keys()].filter(name => name !== cli.name).sort();
  for (const name of bundled) dependencies[name] = cli.version;
  for (const pkg of included.values()) {
    const destination = pkg === cli ? directory : join(directory, "node_modules", pkg.name);
    copyPackageFiles(pkg, destination);
    const manifest = { ...pkg.manifest, version: cli.version };
    delete manifest.devDependencies;
    delete manifest.scripts;
    delete manifest.publishConfig;
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      // Third-party dependencies belong only to the public root. Declaring them
      // inside bundled modules makes npm assume their files are bundled too.
      if (manifest[field]) manifest[field] = Object.fromEntries(Object.entries(manifest[field])
        .filter(([name]) => included.has(name))
        .map(([name]) => [name, cli.version]));
    }
    if (pkg === cli) {
      delete manifest.private;
      manifest.publishConfig = { access: "public" };
      manifest.dependencies = dependencies;
      manifest.optionalDependencies = optionalDependencies;
      manifest.bundleDependencies = bundled;
      manifest.scripts = { postinstall: "node node_modules/@quotient-forecasting/cassie-skill/install.mjs" };
    } else {
      manifest.private = true;
      delete manifest.bin;
    }
    writeManifest(destination, manifest);
  }
  return { ...cli, path: directory, bundled };
}
