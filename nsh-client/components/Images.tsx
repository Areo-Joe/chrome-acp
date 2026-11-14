import { Image, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { imageName, imageUrl, type DraftImage, type ImageBlock } from "../state/draft";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";

export function ImageBlockView(props: { image: ImageBlock; compact?: boolean; testID?: string }) {
  const expanded = signal(false);
  const failed = signal(false);
  return <Button testID={props.testID} accessibilityLabel={`${expanded() ? "Collapse" : "Expand"} ${imageName(props.image)}`}
    onPress={() => expanded.set(!expanded())} class="items-start rounded border border-border p-1">
    <If when={!failed()} else={<Text class="text-xs text-muted-foreground">Image unavailable</Text>}>
      <Image src={imageUrl(props.image)} accessibilityLabel={imageName(props.image)} onError={() => failed.set(true)}
        style={{ width: expanded() ? 280 : props.compact ? 64 : 224, height: expanded() ? 280 : props.compact ? 64 : 160, objectFit: "contain" }} />
    </If>
  </Button>;
}

export function DraftImages(props: { images: DraftImage[]; remove: (id: number) => void }) {
  return <If when={props.images.length > 0}>
    <View testID="draft-images" class="flex-row flex-wrap gap-2">
      <Each of={props.images} key={image => image.id}>{image => <View testID={`draft-image-${image().id}`} class="gap-1 rounded border border-border p-1">
        <If when={!image().pending} else={<View class="h-16 w-16 items-center justify-center"><Spinner /></View>}>
          <ImageBlockView image={image().block} compact />
        </If>
        <View class="flex-row items-center gap-1">
          <Text class="max-w-28 text-xs text-muted-foreground">{image().name}</Text>
          <Button testID={`remove-image-${image().id}`} accessibilityLabel={`Remove ${image().name}`} onPress={() => props.remove(image().id)} class="p-1">
            <Icon name="x" size={12} />
          </Button>
        </View>
      </View>}</Each>
    </View>
  </If>;
}
