declare module "tweetnacl" {
  interface SecretBox {
    (
      message: Uint8Array,
      nonce: Uint8Array,
      key: Uint8Array
    ): Uint8Array;
    open(
      message: Uint8Array,
      nonce: Uint8Array,
      key: Uint8Array
    ): Uint8Array | null;
  }
  const nacl: {
    secretbox: SecretBox;
  };
  export default nacl;
}
