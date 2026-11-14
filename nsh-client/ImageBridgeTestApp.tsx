// Test-only entry for external-file recognition through the production host.
import { host, mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { readImageSource, prepareImage } from "./state/images";
function App() {
  const result = signal("");
  async function inspect() {
    try {
      const directory = String(host.params.directory);
      const sources = ["image-without-extension", "image-wrong.jpg", "plain-file"];
      const values = await Promise.all(sources.map(async name => {
        const uri = `${directory}${name}`;
        const data = await readImageSource(uri);
        return data === null ? null : (await prepareImage(uri, name, false, data)).block;
      }));
      result.set(JSON.stringify(values));
    } catch (reason) { result.set(String(reason)); }
  }
  return <View><Button testID="inspect" onPress={() => { void inspect(); }}><Text>Inspect files</Text></Button>
    <Text testID="result">{result()}</Text></View>;
}
mount(App);
