import { Catalog } from './catalog/discovery.js';
import { Lifecycle } from './lifecycle/service.js';
import { toolContracts, type ToolName } from './shared/contracts.js';
export class Rootlane {
  constructor(readonly catalog: Catalog, readonly lifecycle: Lifecycle) {}
  async call(name: ToolName, raw: unknown) {
    const contract = toolContracts[name]; const input = contract.input.parse(raw);
    const output = name === 'list_projects' ? await this.catalog.list(input)
      : name === 'get_environment' ? await this.lifecycle.get(input)
      : name === 'get_logs' ? await this.lifecycle.logs(input)
      : this.lifecycle.accept(name === 'start_environment' ? 'start' : 'stop', input);
    return contract.output.parse(output);
  }
}
