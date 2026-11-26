// Temperatures and fans: the hwmon class and the thermal zones over trees
// of their files, the bound on a scan that does not answer, the battery.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Bounded } from './io.ts';
import { MAX_SENSORS, naturalLess, parseBatteryTemp, sysfsSensors } from './sensors.ts';

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

/** A tree of files (path relative to root → content). */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sens-'));
  roots.push(root);
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), content + '\n');
  }
  return root;
}

const scan = (root: string) => sysfsSensors(new Bounded(), root, 1000);

test('hwmon: chips by name (a second of one driver by its directory), labels, thresholds, stopped fans', async () => {
  const s = await scan(
    tree({
      'class/hwmon/hwmon0/name': 'coretemp',
      'class/hwmon/hwmon0/temp1_input': '52000',
      'class/hwmon/hwmon0/temp1_label': 'Package id 0',
      'class/hwmon/hwmon0/temp1_max': '84000',
      'class/hwmon/hwmon0/temp1_crit': '100000',
      'class/hwmon/hwmon0/temp10_input': '47500',
      'class/hwmon/hwmon0/temp10_label': 'Core 10',
      'class/hwmon/hwmon0/temp2_input': '49000',
      'class/hwmon/hwmon0/temp2_label': 'Core 2',
      // An unconnected input's error value, and one that is not a number.
      'class/hwmon/hwmon0/temp3_input': '-128000',
      'class/hwmon/hwmon0/temp4_input': 'N/A',
      'class/hwmon/hwmon1/name': 'nvme',
      'class/hwmon/hwmon1/temp1_input': '38800',
      'class/hwmon/hwmon2/name': 'nvme',
      'class/hwmon/hwmon2/temp1_input': '41000',
      'class/hwmon/hwmon3/name': 'nct6798',
      'class/hwmon/hwmon3/fan1_input': '1180',
      'class/hwmon/hwmon3/fan1_label': 'CPU fan',
      'class/hwmon/hwmon3/fan1_min': '300',
      'class/hwmon/hwmon3/fan1_max': '2200',
      'class/hwmon/hwmon3/fan2_input': '0',
      'class/hwmon/hwmon3/fan2_min': '0',
      // Thermal zones are not read while hwmon has temperatures.
      'class/thermal/thermal_zone0/type': 'acpitz',
      'class/thermal/thermal_zone0/temp': '27800',
    }),
  );
  expect(s?.temps).toEqual([
    { chip: 'coretemp', label: 'Core 2', tempC: 49 },
    { chip: 'coretemp', label: 'Core 10', tempC: 47.5 },
    { chip: 'coretemp', label: 'Package id 0', tempC: 52, highC: 84, critC: 100 },
    { chip: 'nvme', label: 'temp1', tempC: 38.8 },
    { chip: 'nvme (hwmon2)', label: 'temp1', tempC: 41 },
  ]);
  expect(s?.fans).toEqual([
    { chip: 'nct6798', label: 'CPU fan', rpm: 1180, minRpm: 300, maxRpm: 2200 },
    { chip: 'nct6798', label: 'fan2', rpm: 0 },
  ]);
});

test('the thermal zones when hwmon has no temperature, with their lowest hot and critical trip points', async () => {
  const s = await scan(
    tree({
      'class/hwmon/hwmon0/name': 'pwmfan',
      'class/hwmon/hwmon0/fan1_input': '3400',
      'class/thermal/thermal_zone0/type': 'cpu-thermal',
      'class/thermal/thermal_zone0/temp': '61234',
      'class/thermal/thermal_zone0/trip_point_0_type': 'passive',
      'class/thermal/thermal_zone0/trip_point_0_temp': '80000',
      'class/thermal/thermal_zone0/trip_point_1_type': 'hot',
      'class/thermal/thermal_zone0/trip_point_1_temp': '90000',
      'class/thermal/thermal_zone0/trip_point_2_type': 'critical',
      'class/thermal/thermal_zone0/trip_point_2_temp': '105000',
      'class/thermal/thermal_zone1/type': 'gpu-thermal',
      'class/thermal/thermal_zone1/temp': '55000',
      'class/thermal/thermal_zone2/type': 'broken',
      'class/thermal/cooling_device0/type': 'Processor',
    }),
  );
  expect(s?.temps).toEqual([
    { chip: 'thermal', label: 'cpu-thermal', tempC: 61.2, highC: 80, critC: 105 },
    { chip: 'thermal', label: 'gpu-thermal', tempC: 55 },
  ]);
  expect(s?.fans).toEqual([{ chip: 'pwmfan', label: 'fan1', rpm: 3400 }]);
});

test('nothing gives none; each list is bounded', async () => {
  expect(await scan(tree({}))).toBeUndefined();
  const files: Record<string, string> = { 'class/hwmon/hwmon0/name': 'many' };
  for (let i = 1; i <= MAX_SENSORS + 20; i++) {
    files[`class/hwmon/hwmon0/temp${i}_input`] = '40000';
    files[`class/hwmon/hwmon0/fan${i}_input`] = '1000';
  }
  const s = await scan(tree(files));
  expect([s?.temps?.length, s?.fans?.length]).toEqual([MAX_SENSORS, MAX_SENSORS]);
});

test('a scan that does not answer within its budget gives none, and none starts again until it ended', async () => {
  const io = new Bounded();
  let release!: () => void;
  const hung = new Promise<string>((r) => (release = () => r('done')));
  const start = Date.now();
  expect(await io.run('sensors', 100, () => hung)).toBeNull();
  expect(Date.now() - start).toBeLessThan(1000);
  let ran = false;
  expect(
    await io.run('sensors', 100, async () => {
      ran = true;
      return 'x';
    }),
  ).toBeNull();
  expect(ran).toBe(false);
  release();
  await hung;
  await new Promise((r) => setTimeout(r, 0));
  expect(await io.run('sensors', 100, async () => 'next')).toBe('next');
});

test("the battery's temperature (hundredths of a degree); none without one", () => {
  const s =
    parseBatteryTemp(`+-o AppleSmartBattery  <class AppleSmartBattery, id 0x1000008e4, registered, matched, active, busy 0 (1 ms), retain 8>
    {
      "PostChargeWaitSeconds" = 120
      "BatteryData" = {"Temperature"=9999,"CycleCount"=12}
      "VirtualTemperature" = 3409
      "Temperature" = 3074
    }
`);
  expect(s).toEqual({ temps: [{ chip: 'battery', label: 'Battery', tempC: 30.7 }] });
  expect(parseBatteryTemp('')).toBeUndefined();
});

test('natural order', () => {
  const cases: Array<[string, string, boolean]> = [
    ['Core 2', 'Core 10', true],
    ['Core 10', 'Core 2', false],
    ['temp1', 'temp1', false],
    ['fan', 'fan1', true],
    ['a07', 'a7', false],
    ['acpitz', 'coretemp', true],
  ];
  for (const [a, b, want] of cases) expect([a, b, naturalLess(a, b)]).toEqual([a, b, want]);
});
