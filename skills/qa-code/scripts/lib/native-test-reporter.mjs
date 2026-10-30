// Native Node events retain the actual test file and skip/todo status.
export default async function* reporter(source){
  for await(const event of source)if(['test:pass','test:fail'].includes(event.type))yield JSON.stringify(event)+'\n';
}
