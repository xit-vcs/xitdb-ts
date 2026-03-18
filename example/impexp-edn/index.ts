#!/usr/bin/env bun
import { importEdn } from './import-edn';
import { exportEdn } from './export-edn';

function printUsage(): void {
  console.log('Usage:');
  console.log('  bun run example/impexp-edn/index.ts import_edn <file.edn> <output.xdb>  Import EDN file into xitdb database');
  console.log('  bun run example/impexp-edn/index.ts export_edn <file.xdb>              Export xitdb database as EDN to stdout');
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  const command = args[0];

  switch (command) {
    case 'import_edn': {
      if (args.length !== 3) {
        console.error('Usage: bun run example/impexp-edn/index.ts import_edn <file.edn> <output.xdb>');
        process.exit(1);
      }
      const [, ednPath, dbPath] = args;
      try {
        importEdn(ednPath, dbPath);
        console.log(`Successfully imported ${ednPath} to ${dbPath}`);
      } catch (error) {
        console.error(`Error importing EDN: ${error}`);
        process.exit(1);
      }
      break;
    }

    case 'export_edn': {
      if (args.length !== 2) {
        console.error('Usage: bun run example/impexp-edn/index.ts export_edn <file.xdb>');
        process.exit(1);
      }
      const [, dbPath] = args;
      try {
        exportEdn(dbPath);
      } catch (error) {
        console.error(`Error exporting EDN: ${error}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main();
