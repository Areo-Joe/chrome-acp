import { mount, Text, View } from "nsh";

function App() {
  return (
    <View class="flex-1 items-center justify-center bg-background">
      <Text class="text-2xl font-semibold text-foreground">Hello World</Text>
    </View>
  );
}

mount(App);
