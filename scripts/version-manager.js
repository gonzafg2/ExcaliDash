#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const VERSION_FILE = path.join(ROOT_DIR, 'VERSION');
const BACKEND_PACKAGE = path.join(ROOT_DIR, 'backend/package.json');
const FRONTEND_PACKAGE = path.join(ROOT_DIR, 'frontend/package.json');

const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m',
  bright: '\x1b[1m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function showHelp() {
  log('ExcaliDash Version Manager', 'blue');
  log('');
  log('Usage: node scripts/version-manager.js [COMMAND] [VERSION_TYPE]');
  log('');
  log('Commands:');
  log('  get                 Get current version');
  log('  set VERSION         Set specific version (e.g., 1.2.3)');
  log('  patch               Bump patch version (1.0.0 → 1.0.1)');
  log('  minor               Bump minor version (1.0.0 → 1.1.0)');
  log('  major               Bump major version (1.0.0 → 2.0.0)');
  log('  sync                Sync version to all package.json files');
  log('  help                Show this help message');
  log('');
  log('Examples:');
  log('  node scripts/version-manager.js get');
  log('  node scripts/version-manager.js set 1.2.3');
  log('  node scripts/version-manager.js patch');
  log('  node scripts/version-manager.js minor');
}

function getCurrentVersion() {
  try {
    if (fs.existsSync(VERSION_FILE)) {
      return fs.readFileSync(VERSION_FILE, 'utf8').trim();
    }
    } catch (error) {
  }
  return '0.1.0'; // Default version if VERSION file doesn't exist
}

function setVersion(newVersion) {
  if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
    log(`Error: Version must be in format X.Y.Z (e.g., 1.2.3)`, 'red');
    process.exit(1);
  }

  try {
    fs.writeFileSync(VERSION_FILE, newVersion);
    log(`✓ Updated VERSION file to ${newVersion}`, 'green');
  } catch (error) {
    log(`Error writing VERSION file: ${error.message}`, 'red');
    process.exit(1);
  }

  syncVersionToPackages(newVersion);
}

function bumpVersion(bumpType) {
  const currentVersion = getCurrentVersion();
  const [major, minor, patch] = currentVersion.split('.').map(Number);

  let newMajor = major;
  let newMinor = minor;
  let newPatch = patch;

  switch (bumpType) {
    case 'patch':
      newPatch = patch + 1;
      break;
    case 'minor':
      newMinor = minor + 1;
      newPatch = 0;
      break;
    case 'major':
      newMajor = major + 1;
      newMinor = 0;
      newPatch = 0;
      break;
    default:
      log(`Error: Invalid bump type. Use 'patch', 'minor', or 'major'`, 'red');
      process.exit(1);
  }

  const newVersion = `${newMajor}.${newMinor}.${newPatch}`;
  setVersion(newVersion);
}

function updatePackageJson(packagePath, version) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    packageJson.version = version;
    fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
    log(`✓ Updated ${packagePath} to version ${version}`, 'green');
  } catch (error) {
    if (error.code === 'ENOENT') {
      log(`⚠️  ${packagePath} not found`, 'yellow');
    } else {
      log(`Error updating ${packagePath}: ${error.message}`, 'red');
    }
  }
}

function syncVersionToPackages(version) {
  updatePackageJson(BACKEND_PACKAGE, version);
  updatePackageJson(FRONTEND_PACKAGE, version);
}

const args = process.argv.slice(2);
const command = args[0];
const arg = args[1];

switch (command) {
  case 'get':
    console.log(getCurrentVersion());
    break;
  case 'set':
    if (!arg) {
      log('Error: Version required for "set" command', 'red');
      showHelp();
      process.exit(1);
    }
    setVersion(arg);
    break;
  case 'patch':
  case 'minor':
  case 'major':
    bumpVersion(command);
    break;
  case 'sync':
    const version = getCurrentVersion();
    syncVersionToPackages(version);
    break;
  case 'help':
  case undefined:
    showHelp();
    break;
  default:
    log(`Error: Unknown command '${command}'`, 'red');
    showHelp();
    process.exit(1);
}
