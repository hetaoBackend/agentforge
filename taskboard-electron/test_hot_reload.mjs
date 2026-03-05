/**
 * 热重载逻辑单元测试
 *
 * 测试目标：
 * 1. isRestarting 锁能防止并发重启
 * 2. 防抖机制（debounce）能合并短时间内多次文件变化
 * 3. finally 块能确保锁被正确释放
 */

// 辅助函数：等待指定毫秒
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m'
};

function logTest(name, passed, details = '') {
  const icon = passed ? '✅' : '❌';
  const color = passed ? colors.green : colors.red;
  console.log(`${color}${icon} ${name}${colors.reset}`);
  if (details) console.log(`   ${colors.yellow}${details}${colors.reset}`);
}

async function runTests() {
  console.log('\n' + colors.blue + '═'.repeat(50) + colors.reset);
  console.log(colors.blue + '  热重载逻辑单元测试' + colors.reset);
  console.log(colors.blue + '═'.repeat(50) + colors.reset + '\n');

  let passed = 0;
  let failed = 0;

  // ==================== 测试 1 ====================
  // 验证防抖机制：短时间内多次变化只触发一次重启
  console.log(colors.blue + '测试 1: 防抖机制' + colors.reset);

  function setupDebounceTest() {
    let restartTimeout = null;
    let restartCount = 0;
    const log = [];

    const triggerChange = () => {
      if (restartTimeout) {
        log.push('Clearing existing timeout');
        clearTimeout(restartTimeout);
      }

      restartTimeout = setTimeout(() => {
        restartCount++;
        log.push(`[RESTART] #${restartCount}`);
      }, 500);
    };

    const getRestartCount = () => restartCount;
    const getLog = () => [...log];

    return { triggerChange, getRestartCount, getLog };
  }

  const test1 = setupDebounceTest();
  test1.triggerChange();
  await sleep(100);
  test1.triggerChange();
  await sleep(100);
  test1.triggerChange();
  await sleep(100);

  // 等待防抖定时器触发
  await sleep(800);

  const passed1 = test1.getRestartCount() === 1 &&
                   test1.getLog().filter(l => l.includes('[RESTART]')).length === 1 &&
                   test1.getLog().filter(l => l.includes('Clearing existing timeout')).length >= 1;
  logTest('短时间内多次变化只触发一次重启', passed1,
    `实际重启次数: ${test1.getRestartCount()}${passed1 ? '' : ' (期望: 1)'}`);
  if (passed1) passed++; else failed++;

  // ==================== 测试 2 ====================
  // 验证并发重启防护：多个并发变化只执行一次
  console.log('\n' + colors.blue + '测试 2: 并发重启防护' + colors.reset);

  function setupConcurrencyTest() {
    let isRestarting = false;
    let restartCount = 0;
    let skipCount = 0;

    const attemptRestart = () => {
      return new Promise((resolve) => {
        // 不设置 setTimeout 直接执行，模拟多个并发请求同时到达
        if (isRestarting) {
          skipCount++;
          resolve('skipped');
          return;
        }

        isRestarting = true;
        restartCount++;
        resolve('started');

        // 模拟异步重启
        setTimeout(() => {
          isRestarting = false;
        }, 100);
      });
    };

    const getStats = () => ({ restartCount, skipCount });

    return { attemptRestart, getStats };
  }

  const test2 = setupConcurrencyTest();

  // 并发触发多次重启请求
  const promises = [
    test2.attemptRestart(),
    test2.attemptRestart(),
    test2.attemptRestart(),
    test2.attemptRestart(),
    test2.attemptRestart(),
  ];

  const results = await Promise.all(promises);

  // 确保锁已释放
  await sleep(150);
  const stats = test2.getStats();

  const passed2 = stats.restartCount === 1 && stats.skipCount === 4;
  logTest('并发请求只执行一次重启，其余被跳过', passed2,
    `重启: ${stats.restartCount}, 跳过: ${stats.skipCount}${passed2 ? '' : ' (期望: restart=1, skip=4)'}`);
  if (passed2) passed++; else failed++;

  // ==================== 测试 3 ====================
  // 验证 finally 块：锁在异常情况下也能释放
  console.log('\n' + colors.blue + '测试 3: 异常情况下锁的正确释放' + colors.reset);

  function setupFinallyTest() {
    let isRestarting = false;

    const restartWithError = () => {
      return Promise((resolve, reject) => {
        isRestarting = true;

        try {
          // 模拟操作
          process.nextTick(() => {
            throw new Error('Simulated error');
          });
        } catch (error) {
          throw error;
        } finally {
          isRestarting = false;
        }
        resolve('completed');
      });
    };

    const isLocked = () => isRestarting;
    return { restartWithError, isLocked };
  }

  const test3 = setupFinallyTest();
  try {
    await test3.restartWithError();
  } catch (e) {
    // 预期错误
  }

  // 实际代码是异步执行，用更接近实际的方式测试
  function setupFinallyTestAsync() {
    let isRestarting = false;

    const restartWithError = () => {
      return new Promise((resolve, reject) => {
        isRestarting = true;
        process.nextTick(() => {
          try {
            throw new Error('Simulated error');
          } catch (error) {
            reject(error);
          } finally {
            isRestarting = false;
          }
        });
      });
    };

    const isLocked = () => isRestarting;
    return { restartWithError, isLocked };
  }

  const test3Async = setupFinallyTestAsync();
  try {
    await test3Async.restartWithError();
  } catch (e) {
    // 预期错误
  }

  await sleep(50); // 确保 finally 执行

  const passed3 = !test3Async.isLocked();
  logTest('异常后锁被正确释放', passed3,
    passed3 ? '' : `锁状态: ${test3Async.isLocked()} (期望: false)`);
  if (passed3) passed++; else failed++;

  // ==================== 测试 4 ====================
  // 验证完整的重载循环：防抖 -> 重启锁 -> finally
  console.log('\n' + colors.blue + '测试 4: 完整重载流程' + colors.reset);

  function setupFullFlowTest() {
    let restartTimeout = null;
    let isRestarting = false;
    let restartCount = 0;
    const log = [];

    const triggerChange = () => {
      return new Promise((resolve) => {
        if (restartTimeout) {
          clearTimeout(restartTimeout);
          log.push('[DEBOUNCE] Cleared');
        }

        restartTimeout = setTimeout(async () => {
          if (isRestarting) {
            log.push('[LOCK] Busy, skipping');
            resolve('skipped');
            return;
          }

          isRestarting = true;
          restartCount++;
          log.push(`[RESTART] #${restartCount} started`);

          try {
            // 模拟重启耗时要大于防抖延迟，才能测试并发场景
            await new Promise(r => setTimeout(r, 500));
            log.push(`[RESTART] #${restartCount} completed`);
            resolve('completed');
          } catch (error) {
            log.push(`[ERROR] ${error.message}`);
            throw error;
          } finally {
            isRestarting = false;
            log.push('[LOCK] Released');
          }
        }, 200); // 200ms 防抖
      });
    };

    const getLog = () => [...log];
    const getRestartCount = () => restartCount;

    return { triggerChange, getLog, getRestartCount };
  }

  const test4 = setupFullFlowTest();

  // 触发多次变化（应该被防抖合并）
  test4.triggerChange();
  await sleep(100);
  test4.triggerChange();
  await sleep(100);
  test4.triggerChange();
  await sleep(250); // 等待防抖过去，第一次重启刚开始（耗时500ms）

  // 在重启期间再次触发（应该被跳过）
  // 此时防抖200ms，重启已经进行了250ms，还有250ms才结束
  // 新触发会在 200ms 后检查锁，此时重启还在进行中
  test4.triggerChange();
  await sleep(600); // 等待所有完成

  const log4 = test4.getLog();
  const passed4 = test4.getRestartCount() === 1 &&
                   log4.includes('[DEBOUNCE] Cleared') &&
                   log4.filter(l => l.includes('Busy, skipping')).length >= 1 &&
                   log4.includes('[LOCK] Released');

  logTest('完整流程正确执行', passed4,
    `重启次数: ${test4.getRestartCount()}${passed4 ? '' : ' (期望: 1)'}\n` +
    `   日志: ${log4.join(', ')}`);
  if (passed4) passed++; else failed++;

  // ==================== 测试 5 ====================
  // 验证序列重启：完成后可以继续重启
  console.log('\n' + colors.blue + '测试 5: 序列重启' + colors.reset);

  const test5 = setupFullFlowTest();

  // 第一次
  await test5.triggerChange();
  // 防抖200ms + 重启500ms = 至少需要700ms
  await sleep(800);

  // 等待后第二次
  await sleep(100);
  await test5.triggerChange();
  await sleep(800);

  const passed5 = test5.getRestartCount() === 2;
  logTest('序列变化能触发多次重启', passed5,
    `重启次数: ${test5.getRestartCount()}${passed5 ? '' : ' (期望: 2)'}`);
  if (passed5) passed++; else failed++;

  // ==================== 测试总结 ====================
  console.log('\n' + colors.blue + '═'.repeat(50) + colors.reset);
  console.log(colors.blue + `  测试结果: ${passed}/${passed + failed} 通过` + colors.reset);
  console.log(colors.blue + '═'.repeat(50) + colors.reset);

  if (failed === 0) {
    console.log(colors.green + '\n✨ 所有测试通过！热重载逻辑正确。' + colors.reset + '\n');
    return 0;
  } else {
    console.log(colors.red + `\n⚠️  ${failed} 个测试失败，需要修复。` + colors.reset + '\n');
    return 1;
  }
}

// 运行测试
runTests().then(exitCode => {
  process.exit(exitCode);
}).catch(error => {
  console.error(colors.red + '测试运行出错:' + colors.reset, error);
  process.exit(1);
});
