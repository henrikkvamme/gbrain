# Preserve the input-addressed paths used by the installed CPU runtime.
# Nix checks cache signatures; image.py additionally hashes every actual NAR.
let
  pin = builtins.fromJSON (builtins.readFile ./closure.json);
in
builtins.fetchClosure {
  fromStore = pin.binaryCache;
  fromPath = pin.storePath;
  inputAddressed = true;
}
