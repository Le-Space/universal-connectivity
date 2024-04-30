extern crate prost_build;

fn main() {
   prost_build::Config::new()
      //.out_dir("src/generated")
       .compile_protos(&["src/peer.proto"], &["src/"])
       .unwrap();
}