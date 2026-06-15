import re
import json

try:
    with open('src/data/stocklist.ts', 'r', encoding='utf-8') as f:
        content = f.read()
        
    # Find the export default array
    match = re.search(r'export default\s+(\[.*?\]);', content, re.DOTALL)
    if not match:
        print("Could not find array")
        exit(1)
        
    array_str = match.group(1)
    
    # Simple JS object to JSON string converter
    # Replace single quotes with double quotes
    array_str = array_str.replace("'", '"')
    
    # Add quotes around keys
    array_str = re.sub(r'([{,]\s*)([a-zA-Z0-9_]+)\s*:', r'\1"\2":', array_str)
    
    # Remove trailing commas
    array_str = re.sub(r',\s*([\]}])', r'\1', array_str)
    
    data = json.loads(array_str)
    
    with open('scripts/stocklist.json', 'w', encoding='utf-8') as out:
        json.dump(data, out, indent=2)
        
    print(f"Successfully extracted {len(data)} symbols to scripts/stocklist.json")
except Exception as e:
    print(f"Error: {e}")
