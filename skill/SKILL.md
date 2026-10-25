---
name: agent-id-platform-research
description: 只读识别 BSC 上 Four.meme、Flap、Gang.fun 的 Agent ID 相关代币，核对阶段与报价资产，并整理交易前需确认的信息。不发起真实买卖。
---

# Agent ID 三平台识别

当用户给出合约地址并希望了解平台或交易路径时，先核对 BSC chainId 56、完整 CA 和实际链上登记。币名、网页标记、后缀不能代替登记证明。

- Four.meme：核对 OpenFour Core 的 token 记录、Agent ID 模板及 Vault 阶段。
- Flap：从 Factory/Reader 关联市场地址和 token，区分 ID AGENT CURVE 的份额内盘、已发行与后续外盘。份额不等于可转账 ERC-20。
- Gang.fun：核对对应 Launchpad 的曲线登记、报价资产与阶段。不要仅凭地址后缀判定 .ai 专属资格。

识别后说明当前阶段、报价资产、可能的费用与限制，并标明仍需实时复核的事项。合约升级、权限、可见源码中的重入防护和实际池要在任何真实交易前重新检查。此公开 Skill 只用于研究和准备，不包含钱包授权、私有交易执行命令或自动下单许可。
