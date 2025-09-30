#!/usr/bin/env node

/**
 * Patch discord.js to support Type 18 Label components in modals
 * This script is automatically run after npm install
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const patches = [
    {
        file: 'node_modules/discord.js/src/structures/ModalSubmitFields.js',
        search: `    this.fields = components.reduce((accumulator, next) => {
      next.components.forEach(component => accumulator.set(component.customId, component));
      return accumulator;
    }, new Collection());`,
        replace: `    this.fields = components.reduce((accumulator, next) => {
      // Handle Type 18 (Label) components which have a single 'component' field
      if (next.component) {
        accumulator.set(next.component.customId, next.component);
      }
      // Handle Type 1 (Action Row) components which have 'components' array
      else if (next.components) {
        next.components.forEach(component => accumulator.set(component.customId, component));
      }
      return accumulator;
    }, new Collection());`
    },
    {
        file: 'node_modules/discord.js/src/structures/ModalSubmitInteraction.js',
        search: `  static transformComponent(rawComponent) {
    return rawComponent.components
      ? {
          type: rawComponent.type,
          components: rawComponent.components.map(component => this.transformComponent(component)),
        }
      : {
          value: rawComponent.value,
          type: rawComponent.type,
          customId: rawComponent.custom_id,
        };
  }`,
        replace: `  static transformComponent(rawComponent) {
    // Handle Type 18 (Label) components which have a single 'component' field
    if (rawComponent.component) {
      return {
        type: rawComponent.type,
        component: this.transformComponent(rawComponent.component),
      };
    }
    // Handle Type 1 (Action Row) components which have 'components' array
    else if (rawComponent.components) {
      return {
        type: rawComponent.type,
        components: rawComponent.components.map(component => this.transformComponent(component)),
      };
    }
    // Handle leaf components (TextInput, Select, etc.)
    else {
      return {
        value: rawComponent.value,
        type: rawComponent.type,
        customId: rawComponent.custom_id,
        values: rawComponent.values,
      };
    }
  }`
    }
];

console.log('Patching discord.js for Type 18 Label component support...');

for (const patch of patches) {
    const filePath = path.resolve(__dirname, '..', patch.file);

    try {
        let content = fs.readFileSync(filePath, 'utf8');

        if (content.includes(patch.search)) {
            content = content.replace(patch.search, patch.replace);
            fs.writeFileSync(filePath, content, 'utf8');
            console.log(`✅ Patched: ${patch.file}`);
        } else if (content.includes(patch.replace)) {
            console.log(`✓ Already patched: ${patch.file}`);
        } else {
            console.warn(`⚠️  Could not find code to patch in: ${patch.file}`);
        }
    } catch (error) {
        console.error(`❌ Error patching ${patch.file}:`, error.message);
    }
}

console.log('Discord.js patching complete!');
