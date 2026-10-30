const command = process.argv.slice(2, 4).join(' ');

if (command === 'gate status') {
  console.log('verdict=pass control=G3 known-good-approval');
  process.exit(0);
}

if (command === 'board verify') {
  console.log('verdict=pass control=G5 evidence-present');
  process.exit(0);
}

console.error(`verdict=fail CONTROL_UNSUPPORTED ${command}`);
process.exit(1);
