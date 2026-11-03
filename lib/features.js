// 功能开关：只放在这一处，各处都读它，不各写各的判断。
// 模型供需模块（页面、导航、两个接口、后台读错误日志）：暂时隐藏。代码、表、数据都留着，把 modelsModule 改成 true 就全部恢复；
// 设置里「读取错误日志」存的值不动，恢复后还是用户原来的选择。
// 是个对象、各处在用的时候才读：只有单测会临时改它（测模块打开时的行为），用完改回去。
export const FEATURES = { modelsModule: false };
export const modelsModuleEnabled = () => FEATURES.modelsModule;
