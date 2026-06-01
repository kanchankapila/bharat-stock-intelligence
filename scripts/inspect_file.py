import os, sys
path = sys.argv[1] if len(sys.argv) > 1 else 'picks_symbols.json'
print('cwd=', os.getcwd())
print('exists=', os.path.exists(path))
if os.path.exists(path):
    print('size=', os.path.getsize(path))
    with open(path, 'rb') as f:
        b = f.read(256)
    print('first_bytes=', b[:256])
