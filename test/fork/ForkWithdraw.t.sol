// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
interface IM { function withdrawUnfilled() external; function canWithdrawUnfilled() external view returns (bool); function mintDeadline() external view returns (uint256); function totalMinted() external view returns (uint256); function treasury() external view returns (address); }
interface IERC20 { function balanceOf(address) external view returns (uint256); }
contract ForkWithdraw is Test {
    IM m = IM(0xBd57F860B043924f4F37d35AC16c3aab37068e9a);
    IERC20 usdt = IERC20(0x55d398326f99059fF775485246999027B3197955);
    address tre = 0x866396d4aee9467b67194431bdbDdE8E8044d8AE;
    function test_ForkWithdraw() public {
        vm.createSelectFork(vm.envString("BSC_RPC_URL"));
        assertEq(m.treasury(), tre);
        uint256 held = usdt.balanceOf(address(m));
        console.log("parked USDT (wei)", held);
        console.log("deadline", m.mintDeadline());
        vm.prank(tre); vm.expectRevert(); m.withdrawUnfilled();           // before day 30: refused
        vm.warp(m.mintDeadline() + 1);
        assertTrue(m.canWithdrawUnfilled());
        vm.prank(address(0xBEEF)); vm.expectRevert(); m.withdrawUnfilled(); // not treasury: refused
        uint256 b0 = usdt.balanceOf(tre);
        vm.prank(tre); m.withdrawUnfilled();
        assertEq(usdt.balanceOf(tre) - b0, held);
        assertEq(usdt.balanceOf(address(m)), 0);
        console.log("withdrawn to treasury (wei)", usdt.balanceOf(tre) - b0);
    }
}
