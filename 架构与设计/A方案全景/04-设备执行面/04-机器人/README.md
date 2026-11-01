# 机器人

[所属区域](<../README.md>) · [设备协议](<../01-设备能力接口/README.md>) · [来源](<../../../../research/2026-11-01-完整架构/设备执行面.md>)

更新：2026-11-01。模块 ID：`robot`。状态：协议与集成方案已细化；无真实机器人接入，未验证物理安全。

## 主方案与非目标

识雨只调用已有高层动作，例如移动到指定区域、抓取已识别物体、返回停靠点；轨迹控制、碰撞防护、限速和停止留在设备既有控制器。默认设备上使用ROS 2原生Action适配器，复用rclpy/rclcpp及已有导航/操作栈，不自研运动规划或实时控制算法。

首个模拟基线采用ROS 2 Jazzy，其官方长期支持至2029年5月；真实设备优先已有受支持厂商版本，不为目录统一强制升级。[发行说明](<https://www.openrobotics.org/blog/2024/5/ros-jazzy-jalisco-released>)

ROS Action提供goal、feedback、result与取消，但不是物理急停保证；停止必须由独立本地机制核验。[Action设计](<https://design.ros2.org/articles/actions.html>)

## 接口映射

| 设备协议对象 | ROS / 本地对象 | 要求 |
|---|---|---|
| capabilityId/version | 允许的Action类型、namespace、schema、控制栈版本 | 不暴露任意publish/service/参数改写 |
| effectId | 稳定goal UUID及端侧映射 | 重复先查本地日志与既有goal，不生成新UUID重做 |
| 参数与范围 | 目标点/物体/区域、速度/载荷上限 | 端侧结合环境与本地策略再核验，模型不能扩大运动范围 |
| installationGeneration/hostEpoch/整数fencingToken/assignmentId | 当前中心世代、启动实例和执行资格 | 与设备协议共同校验，旧中心或Assignment不能新派工 |
| resourceId/resourceEpoch | 机器人或机械臂的独占资源与占用世代 | 同一执行资源一个owner；旧动作未证明停止前不转交资源 |
| 回执与进度 | Feedback、终态、控制器/传感状态 | 接受goal不等于运动开始，success仍需业务后置条件 |
| cancel/stop | Action cancel与本地停止服务/硬件链路 | 取消只是请求；硬件急停独立于DSH/网络 |

命令带expiresAt、Mandate、能力版本和物理范围。小型适配仅做契约校验、效果日志和ROS映射。已有rosbridge可复用受限WebSocket/JSON桥，但不把全ROS图暴露给模型。ROS1桥或厂商SDK是特定设备适配，单独验证兼容与停止语义。

## 执行与本地控制

流程为ready检查、资源锁/范围核验、持久记录effect与goal ID、发送高层goal、反馈观察、终态与后置条件核验、回执。电量不足、定位无效、保护停机、急停未释放或控制栈变化均拒绝新动作。

网络与模型只决定高层目标；运动期间控制器自主按本地周期运行，不能等模型下一句才能停止。默认失联时不接新goal，并按设备验证过的方式暂停或停止当前动作；停止不等于直接断电。

30秒控制租约只限定调度资格，不能充当运动安全watchdog。模拟验收采用“失联后1秒内触发stop；从触发stop起2秒内报告模拟停止”；两个时限的起点分别是失联与stop触发。这仅是替身/模拟参数，真机阈值必须依据速度、制动、载荷、环境和已有安全控制器实测。没有真实激活记录时运动能力disabled。

## 恢复与数据

断连时中心Effect待核对/unknown；端侧保留goal映射、反馈摘要、停止原因。重连先核对本地状态、owner与goal结果，不能从备份恢复后自动继续旧运动。环境、姿态、控制状态变化则旧goal作废，重新计划和授权核验。

急停解除仅由本地获准流程执行，不提供模型“绕过保护/自动复位急停”能力。heartbeat不能将保护停机改写为正常。

只回传任务需要的传感摘要/采样，不默认持续上传视频；日志按设备保留政策。校准与安全配置不是任务工作文件，不随缓存清理。

## 验证与替代

V20用Action替身/模拟器覆盖接受、拒绝、成功、失败、取消拒绝、失联、重复effect、迟到feedback、旧fence、未知终态10类情况。100次重复effect只对应一个活动goal，旧owner新增派工为0；断网后在配置模拟时限内触发本地停止，DSH退出不妨碍本地停止。

V26在明确设备、区域与授权范围内验证独立停止链路、真实制动/停止时限、断网/重启、传感失效和保护停机。模拟成功不证明物理安全，不能开放未验证运动范围。

已有ROS Action则直接复用，不额外叠加ros-mcp-server；已有rosbridge且维护成本低可用受限桥替代；厂商仅SDK则复用其动作/停止接口。无法核对停止的设备只开放遥测，直到满足激活条件。

## 现成SDK的明确接入点

[复用核查](<../../../../research/2026-11-01-复用核查/设备.md>)固定rclpy **7.1.12**（Jazzy索引版本、Apache-2.0）。直接用`ActionClient.wait_for_server()`、`send_goal_async(..., goal_uuid=...)`和`ClientGoalHandle.get_result_async()/cancel_goal_async()`；既有Action服务/厂商SDK保留原生命周期和控制器，不自研ROS客户端，也不复制`action/client.py`脱离rcl/rmw/消息生成栈。

识雨只补稳定effect→goal UUID、授权/范围/资源映射、持久结果摘要及停止核对。源码显示client handle是内存weakref，server默认结果保留900秒，不能把原生Action当永久账本。V20增加结果保留期耗尽和客户端重启丢handle，无法核对保持unknown，不生成新UUID重发。V26仍需真实本地停止与厂商版本验证；ROS取消API和协议成功不等于物理安全。本轮复制源码0、运行0。
