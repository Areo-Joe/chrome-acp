#!/usr/bin/env bash
set -euo pipefail
ndk_root="$1"
output_dir="$2"
codec_dir="$(cd "$(dirname "$0")" && pwd)"
case "$(uname -s)" in
  Darwin) build_host=darwin-x86_64 ;;
  Linux) build_host=linux-x86_64 ;;
  *) echo "Unsupported Android build host" >&2; exit 1 ;;
esac
toolchain="$ndk_root/toolchains/llvm/prebuilt/$build_host/bin"
export CARGO_TARGET_DIR="$codec_dir/../.nsh/image-codec-android"
for entry in 'aarch64-linux-android:aarch64-linux-android:arm64-v8a' 'x86_64-linux-android:x86_64-linux-android:x86_64' 'armv7-linux-androideabi:armv7a-linux-androideabi:armeabi-v7a' 'i686-linux-android:i686-linux-android:x86'; do
  IFS=: read -r target compiler abi <<< "$entry"
  linker_key="CARGO_TARGET_$(echo "$target" | tr '[:lower:]-' '[:upper:]_')_LINKER"
  env "$linker_key=$toolchain/${compiler}28-clang" cargo +stable build --manifest-path "$codec_dir/Cargo.toml" --locked --release --target "$target"
  mkdir -p "$output_dir/$abi"
  cp "$CARGO_TARGET_DIR/$target/release/libnsh_client_image_codec.so" "$output_dir/$abi/"
done
